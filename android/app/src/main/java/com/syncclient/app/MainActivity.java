package com.syncclient.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "SyncClient";
    private static final String ACTION_TASKER_SYNC = "com.syncclient.app.TASKER_SYNC";
    private volatile boolean isRunning = false;
    private ServerSocket serverSocket;
    private volatile String latestOAuthToken = null;
    private BroadcastReceiver taskerReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(StreamedFilesystem.class);
        super.onCreate(savedInstanceState);
        startLocalServer();
        handleIntent(getIntent());
        registerTaskerReceiver();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            Uri data = intent.getData();
            if (data != null && "syncclient".equals(data.getScheme())) {
                String host = data.getHost();
                if ("sync".equals(host)) {
                    String pairId = data.getLastPathSegment();
                    Log.i(TAG, "Deep link sync received for pair: " + pairId);
                    Toast.makeText(this, "Sync triggered for: " + pairId, Toast.LENGTH_SHORT).show();
                } else if ("oauth".equals(host)) {
                    Log.i(TAG, "OAuth deep link received");
                }
            }
        }
    }

    private void registerTaskerReceiver() {
        taskerReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent != null && ACTION_TASKER_SYNC.equals(intent.getAction())) {
                    Log.i(TAG, "Tasker sync broadcast received");
                    Toast.makeText(context, "Tasker sync triggered", Toast.LENGTH_SHORT).show();
                }
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_TASKER_SYNC);
        registerReceiver(taskerReceiver, filter);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        isRunning = false;
        if (taskerReceiver != null) {
            unregisterReceiver(taskerReceiver);
            taskerReceiver = null;
        }
        try {
            if (serverSocket != null && !serverSocket.isClosed()) {
                serverSocket.close();
            }
        } catch (Exception e) {
            // ignore
        }
    }

    private void startLocalServer() {
        if (isRunning) return;
        isRunning = true;
        new Thread(() -> {
            try {
                serverSocket = new ServerSocket(3005, 10, InetAddress.getByName("127.0.0.1"));
                Log.i(TAG, "Servidor autónomo de OAuth escuchando en 127.0.0.1:3005 (Sin necesidad de PC)");
                while (isRunning && !serverSocket.isClosed()) {
                    try {
                        Socket socket = serverSocket.accept();
                        handleClient(socket);
                    } catch (Exception e) {
                        if (isRunning) Log.w(TAG, "Error aceptando conexión: " + e.getMessage());
                    }
                }
            } catch (Exception e) {
                Log.i(TAG, "El puerto 3005 ya se encuentra en uso: " + e.getMessage());
            }
        }).start();
    }

    private void handleClient(Socket socket) {
        try (Socket s = socket;
             BufferedReader reader = new BufferedReader(new InputStreamReader(s.getInputStream()));
             OutputStream out = s.getOutputStream()) {
            String requestLine = reader.readLine();
            if (requestLine == null) return;
            Log.d(TAG, "Petición HTTP entrante al servidor nativo Android: " + requestLine);

            int contentLength = 0;
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                if (line.toLowerCase().startsWith("content-length:")) {
                    contentLength = Integer.parseInt(line.substring("content-length:".length()).trim());
                }
            }

            if (requestLine.startsWith("GET /api/oauth/callback")) {
                String html = "<!DOCTYPE html><html lang=\"es\"><head><meta charset=\"UTF-8\">"
                        + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">"
                        + "<title>SyncClient – Autenticación Nativa</title>"
                        + "<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0;text-align:center;} .card{background:#1e293b;padding:2rem;border-radius:1rem;max-width:340px;box-shadow:0 10px 25px rgba(0,0,0,0.5);border:1px solid #334155;} .icon{font-size:3.5rem;margin-bottom:1rem;} h2{margin:0 0 .5rem;font-size:1.4rem;color:#fff;} p{color:#94a3b8;margin:0;font-size:0.95rem;line-height:1.4;}</style>"
                        + "</head><body><div class=\"card\"><div class=\"icon\" id=\"icon\">⏳</div>"
                        + "<h2 id=\"title\">Autenticación Autónoma</h2><p id=\"msg\">Conectando con Google Drive localmente en tu dispositivo...</p></div>"
                        + "<script>"
                        + "const hash = window.location.hash.substring(1) || window.location.search.substring(1);"
                        + "const params = new URLSearchParams(hash);"
                        + "const token = params.get('access_token') || params.get('token');"
                        + "if (token) {"
                        + "  fetch('http://127.0.0.1:3005/api/oauth/token', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({token}) });"
                        + "  document.getElementById('icon').textContent = '✅';"
                        + "  document.getElementById('title').textContent = '¡Conexión Exitosa!';"
                        + "  document.getElementById('msg').textContent = 'Sesión iniciada sin necesidad de PC. Volviendo a la app SyncClient...';"
                        + "  setTimeout(() => { window.location.href = 'syncclient://oauth?access_token=' + encodeURIComponent(token); }, 400);"
                        + "} else {"
                        + "  document.getElementById('icon').textContent = '❌';"
                        + "  document.getElementById('title').textContent = 'Error de Autenticación';"
                        + "  document.getElementById('msg').textContent = 'No se encontró el token de seguridad en la respuesta de Google.';"
                        + "}"
                        + "</script></body></html>";
                byte[] bytes = html.getBytes(StandardCharsets.UTF_8);
                String resp = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n";
                out.write(resp.getBytes(StandardCharsets.UTF_8));
                out.write(bytes);
                out.flush();
            } else if (requestLine.startsWith("POST /api/oauth/token")) {
                if (contentLength > 0) {
                    char[] bodyChars = new char[contentLength];
                    int read = 0;
                    while (read < contentLength) {
                        int r = reader.read(bodyChars, read, contentLength - read);
                        if (r == -1) break;
                        read += r;
                    }
                    String body = new String(bodyChars);
                    int idx = body.indexOf("\"token\":");
                    if (idx != -1) {
                        int start = body.indexOf("\"", idx + 8) + 1;
                        int end = body.indexOf("\"", start);
                        if (start > 0 && end > start) {
                            latestOAuthToken = body.substring(start, end);
                            Log.i(TAG, "Token OAuth capturado exitosamente en la memoria del celular/tablet.");
                        }
                    }
                }
                String json = "{\"success\":true}";
                byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
                String resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n";
                out.write(resp.getBytes(StandardCharsets.UTF_8));
                out.write(bytes);
                out.flush();
            } else if (requestLine.startsWith("GET /api/oauth/token")) {
                String json = latestOAuthToken != null ? "{\"token\":\"" + latestOAuthToken + "\"}" : "{\"token\":null}";
                byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
                String resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n";
                out.write(resp.getBytes(StandardCharsets.UTF_8));
                out.write(bytes);
                out.flush();
            } else if (requestLine.startsWith("OPTIONS")) {
                String resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nConnection: close\r\n\r\n";
                out.write(resp.getBytes(StandardCharsets.UTF_8));
                out.flush();
            } else {
                String resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                out.write(resp.getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
        } catch (Exception e) {
            Log.w(TAG, "Error procesando petición HTTP en cliente nativo: " + e.getMessage());
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        isRunning = false;
        if (taskerReceiver != null) {
            unregisterReceiver(taskerReceiver);
            taskerReceiver = null;
        }
        try {
            if (serverSocket != null && !serverSocket.isClosed()) {
                serverSocket.close();
            }
        } catch (Exception e) {
            // ignore
        }
    }
}
