package com.syncclient.app;

import android.os.Environment;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.RandomAccessFile;

@CapacitorPlugin(name = "StreamedFilesystem")
public class StreamedFilesystem extends Plugin {
    private static final int MAX_CHUNK_BYTES = 8 * 1024 * 1024;

    @PluginMethod
    public void readChunk(PluginCall call) {
        String path = call.getString("path");
        long offset = call.getData().optLong("offset", -1);
        Integer requestedLength = call.getInt("length");
        if (path == null || offset < 0 || requestedLength == null || requestedLength <= 0) {
            call.reject("Invalid chunk parameters");
            return;
        }
        int length = Math.min(requestedLength, MAX_CHUNK_BYTES);
        File file = resolvePath(path);
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            if (offset >= input.length()) {
                JSObject result = new JSObject();
                result.put("data", "");
                result.put("bytesRead", 0);
                call.resolve(result);
                return;
            }
            input.seek(offset);
            byte[] bytes = new byte[(int) Math.min(length, input.length() - offset)];
            int read = input.read(bytes);
            if (read < 0) read = 0;
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(bytes, 0, read, Base64.NO_WRAP));
            result.put("bytesRead", read);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Unable to read file chunk", e);
        }
    }

    private File resolvePath(String path) {
        if (path.startsWith("__INTERNAL__/")) {
            return new File(getContext().getFilesDir(), path.substring("__INTERNAL__/".length()));
        }
        String externalRoot = Environment.getExternalStorageDirectory().getAbsolutePath();
        String relative = path.replaceFirst("^/storage/emulated/0/?", "").replaceFirst("^/", "");
        return new File(externalRoot, relative);
    }
}
