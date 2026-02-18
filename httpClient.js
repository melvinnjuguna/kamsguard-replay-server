import http from 'http';

export function netVuRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    
    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'Host': urlObj.hostname,
        'Accept': '*/*',
        'Connection': 'close', // Critical for HTTP/1.0 compatibility
        ...options.headers
      },
      timeout: 10000
    };

    const req = http.request(requestOptions, (res) => {
      let data = '';
      
      res.setEncoding('utf8');
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        const contentType = res.headers['content-type'] || '';
        let parsedData = data;
        
        if (contentType.includes('application/json')) {
          try {
            parsedData = JSON.parse(data);
          } catch (e) {
            // Keep as string if parse fails
          }
        }
        
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          data: parsedData
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout of 10000ms exceeded'));
    });

    if (options.data) {
      req.write(options.data);
    }

    req.end();
  });
}

export function netVuStreamRequest(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    
    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'Host': urlObj.hostname,
        'Accept': '*/*',
        'Connection': 'close'
      }
    };

    const req = http.request(requestOptions, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }
      
      resolve({
        status: res.statusCode,
        headers: res.headers,
        data: res // Return raw stream
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}