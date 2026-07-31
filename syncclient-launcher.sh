#!/bin/bash
cd /home/fayfer/Documentos/Ejecutables/syncclient

# Iniciar servidor
SYNCCLIENT_V2=true npm run dev &
SERVER_PID=$!

# Esperar a que el servidor esté listo
for i in $(seq 1 20); do
    if curl -s http://localhost:3000 > /dev/null 2>&1; then
        echo "Servidor listo en puerto 3000"
        break
    fi
    sleep 1
done

# Iniciar Electron con DevTools abierto
npx electron . --no-sandbox --dev
