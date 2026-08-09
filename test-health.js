const http = require('http');

const checkBackendHealth = (healthUrl) => {
  return new Promise((resolve) => {
    console.log('Sending request to', healthUrl);
    const req = http.get(healthUrl, (res) => {
      console.log('Status Code:', res.statusCode);
      res.resume(); // consume response data to free up memory
      resolve(res.statusCode === 200);
    });
    req.on('error', (err) => {
      console.error('Request error:', err.message);
      resolve(false);
    });
    req.setTimeout(1000, () => {
      console.error('Request timeout');
      req.destroy();
      resolve(false);
    });
  });
};

checkBackendHealth('http://127.0.0.1:3000/api/health').then(console.log);
