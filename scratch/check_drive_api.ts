import { SecureStore } from '../src/utils/secureStore';
import https from 'https';

async function run() {
  const token = await SecureStore.get('gdrive_access_token');
  if (!token) {
    console.log("No token found");
    return;
  }
  
  const fileId = '1GHR5tgtr8iDAPxugpFOAjj7TRwd81XFH'; // Sample file ID
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,trashed,parents&supportsAllDrives=true`;
  
  const req = https.get(url, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log(`Status: ${res.statusCode}`);
      console.log(JSON.parse(data));
    });
  });
  
  req.on('error', e => console.error(e));
}
run();
