Aquí tienes una **auditoría integral de la aplicación y el repositorio [SyncClient](https://github.com/danicampsmen/SyncClient)**, basada en la evaluación de su arquitectura, modelo de seguridad, gestión de datos y calidad de código.

---

# 📋 Auditoría de Software: SyncClient

**Repositorio:** [danicampsmen/SyncClient](https://github.com/danicampsmen/SyncClient)  
**Tipo de Aplicación:** Cliente de sincronización bidireccional multiplataforma para Google Drive (Linux Desktop, Android y Web)  
**Stack Tecnológico:** TypeScript, React, Vite, Electron, Express, Capacitor, Firebase Auth / Google Drive API.

---

## 1. Resumen Ejecutivo

**SyncClient** presenta una propuesta de valor clara y bien estructurada: resolver la sincronización bidireccional entre Google Drive y sistemas locales/móviles. Destaca por su **diseño híbrido** y el intento explícito de mantener una arquitectura mantenible compartiendo lógica clave (`CoreSyncLogic.ts`) entre el backend de escritorio y el entorno nativo de Android.

Sin embargo, se han identificado varios **puntos críticos en seguridad, gestión de credenciales y mantenibilidad del repositorio** que deben atenderse antes de considerar la app lista para producción.

---

## 2. Auditoría de Seguridad (Security Audit)

### 🔴 1. Almacenamiento Inseguro de Tokens (Riesgo: CRÍTICO)
* **Hallazgo:** Los tokens de acceso OAuth se están almacenando en `localStorage`.
* **Impacto:** Si la aplicación o cualquier biblioteca de terceros es vulnerable a una inyección Cross-Site Scripting (XSS), un atacante podría extraer el token de Google Drive con permisos completos sobre los archivos del usuario.
* **Recomendaciones:**
  * **En Electron / Desktop:** Utilizar la API nativa de cifrado de Electron (`safeStorage`) o librerías de llavero del sistema operativo (Keyring / Secret Service en Linux).
  * **En Android / Capacitor:** Almacenar tokens únicamente en soluciones cifradas nativas, como `@capacitor-community/secure-storage` (que usa `EncryptedSharedPreferences` en Android).
  * **En Web:** Utilizar cookies con flag `HttpOnly`, `Secure` y `SameSite=Strict` si existe un servidor intermediario.

### 🟠 2. Riesgo de Localhost Hijacking en el Servidor Express (Riesgo: ALTO)
* **Hallazgo:** La versión de Linux Desktop arranca un servidor Express local (`server.ts`) en `http://localhost:3000` para procesar peticiones.
* **Impacto:** Si la API del servidor Express no valida la autenticidad de las peticiones mediante un secreto dinámico de sesión, **cualquier sitio web malicioso que el usuario visite en su navegador habitual** (Chrome/Firefox) podría enviar peticiones a `http://localhost:3000` y leer o manipular los archivos locales del usuario.
* **Recomendaciones:**
  * Generar un **token secreto aleatorio** durante el arranque de Electron y requerirlo en el header `Authorization: Bearer <SECRET>` en cada llamada al servidor Express local.
  * Verificar que CORS restrija explícitamente los orígenes y bloquear solicitudes no autorizadas.

### 🟡 3. Configuración de Electron y Preload Scripts (Riesgo: MEDIO)
* **Recomendaciones:**
  * Asegurar que en el proceso principal de Electron (`electron/ main`), las opciones `contextIsolation: true`, `nodeIntegration: false` y `sandbox: true` estén explícitamente habilitadas.
  * Limitar la superficie expuesta en el script `preload.ts` a métodos puramente específicos a través de `contextBridge`.

---

## 3. Arquitectura y Lógica de Sincronización

### 🟢 Puntos Fuertes de la Arquitectura
1. **Reutilización de Lógica (DRY):** La abstracción en `src/shared/CoreSyncLogic.ts` para compartir algoritmos entre el backend Express (Desktop) y el motor Capacitor (Android) es una práctica excelente para evitar divergencias de comportamiento.
2. **Modos de Operación Flexibles:** El soporte dual para **Mirror** (1:1 offline) y **Streaming Virtual** (stubs de 1KB) aborda adecuadamente la gestión de espacio en disco.
3. **Subidas Resumibles:** Soporte nativo para *Resumable Uploads* de Google Drive API, crítico para la estabilidad con archivos pesados.

### ⚠️ Puntos de Cuidado y Posibles Errores de Lógica
1. **Riesgo en Deduplicación Automática (`Nota(1).pdf` → `Nota.pdf`):**
   * *Riesgo:* La deduplicación basada puramente en el nombre del archivo puede provocar pérdidas de datos involuntarias si dos documentos legítimos pero distintos comparten patrón de nombre.
   * *Solución:* Antes de eliminar/sobrescribir un duplicado, validar la huella digital del archivo utilizando el campo `md5Checksum` que proporciona la API de Google Drive.
2. **Consistencia Atómica en Modo Streaming (Virtual Stubs):**
   * En el modo *Streaming*, al abrir o modificar un archivo stub de 1KB sin conexión a internet, se deben manejar correctamente los fallos de lectura para no corromper la metadata local del sistema de archivos.
3. **Persistencia de Estado para Sincronizaciones Masivas (100GB+):**
   * Mantener el estado de la cola de sincronización únicamente en memoria es vulnerable a caídas o cierres de la app. Es recomendable persistir el árbol de cambios (*delta sync log*) en una base de datos ligera embebida (como SQLite vía `better-sqlite3` en Node o SQLite plugin en Capacitor).

---

## 4. Calidad del Repositorio y Limpieza de Código

### 🗑️ 1. Inclusión de Artefactos Binarios en Git
* **Hallazgo:** El archivo ejecutable compilado `SyncClient.apk` está incluido en la raíz del repositorio.
* **Problema:** Los binarios aumentan significativamente el tamaño del historial de Git y no pertenecen al control de versiones de código fuente.
* **Solución:** Eliminar `SyncClient.apk` del rastreo de Git (`git rm --cached SyncClient.apk`), añadir `.apk` a `.gitignore` y distribuir los builds mediante **GitHub Releases**.

### 🧹 2. Desorden en Gestores de Paquetes y Archivos Temporales
* **Hallazgo:** Coexisten `package-lock.json`, `bun.lock` y un archivo residual `package.json.tmp` en la raíz.
* **Solución:**
  * Estandarizar un solo gestor de dependencias (NPM o Bun) para el equipo y eliminar el lockfile sobrante.
  * Eliminar `package.json.tmp` y asegurarse de agregarlo a `.gitignore`.

### 🧪 3. Ausencia de Pruebas Automatizadas
* **Hallazgo:** No se aprecian suites de test unitarios o de integración en la estructura del proyecto.
* **Solución:** Al tratarse de un motor de sincronización de archivos (donde un fallo puede corromper o borrar datos del usuario), es fundamental agregar pruebas unitarias (con **Vitest** o **Jest**) para:
  * `CoreSyncLogic.ts` (resolución de conflictos, lógica de filtros).
  * Reglas de deduplicación de archivos.
  * Conversión y mapeo de rutas (local vs. remote pathing).

---

## 5. Plan de Acción Recomendado (Matriz de Prioridades)

| Prioridad | Tarea | Área |
| :--- | :--- | :--- |
| 🔴 **CRÍTICA** | Migrar almacenamiento de tokens de `localStorage` a llaveros seguros nativos (`safeStorage` / `secure-storage`). | Seguridad |
| 🔴 **CRÍTICA** | Proteger la API Express local (`localhost:3000`) con tokens de autenticación de sesión IPC. | Seguridad |
| 🟠 **ALTA** | Eliminar `SyncClient.apk` del repositorio Git y configurar la publicación en GitHub Releases. | Higiene de Git |
| 🟠 **ALTA** | Implementar validación por Hash (`md5Checksum`) en el proceso de deduplicación automática. | Lógica de Datos |
| 🟡 **MEDIA** | Estandarizar gestor de paquetes (NPM/Bun) y eliminar `package.json.tmp`. | Mantenibilidad |
| 🟡 **MEDIA** | Agregar suite de tests unitarios para `CoreSyncLogic.ts` con Vitest. | Calidad / CI/CD |

---

### Conclusión
**SyncClient** posee una arquitectura muy bien pensada en cuanto a versatilidad cross-platform (Linux + Android). Reforzando la seguridad en el manejo de tokens OAuth y la protección de su API local, junto con un control más riguroso de integridad de datos mediante checksums, la aplicación alcanzará un nivel de madurez y robustez de grado de producción.