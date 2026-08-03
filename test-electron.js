const { app } = require('electron');
console.log('app type:', typeof app);
console.log('app exists:', !!app);
app.whenReady().then(() => {
  console.log('ready');
  app.quit();
});
