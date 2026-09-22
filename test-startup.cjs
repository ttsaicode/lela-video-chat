#!/usr/bin/env node
/**
 * Simple startup test to verify the server initializes correctly
 * Run with: node test-startup.js
 */

const http = require('http');
const { spawn } = require('child_process');

console.log('🧪 Testing server startup...\n');

const serverProcess = spawn('node', ['server.cjs'], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: '3456',
    JWT_SECRET: 'test-secret-key-for-development-only-32-chars-minimum',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin123456789012',
    ADMIN_PATH: 'test-admin-path-xyz-24-chars-min'
  },
  stdio: ['pipe', 'pipe', 'pipe']
});

let output = '';
let errorOutput = '';

serverProcess.stdout.on('data', (data) => {
  const str = data.toString();
  output += str;
  console.log('[stdout]', str.trim());
});

serverProcess.stderr.on('data', (data) => {
  const str = data.toString();
  errorOutput += str;
  console.log('[stderr]', str.trim());
});

serverProcess.on('error', (err) => {
  console.error('❌ Failed to start server process:', err.message);
  process.exit(1);
});

serverProcess.on('close', (code) => {
  console.log(`\n📋 Server process exited with code: ${code}`);
  if (code !== 0 && code !== null) {
    console.error('❌ Server failed to start properly');
    process.exit(1);
  }
});

// Wait for server to start, then test health endpoint
setTimeout(() => {
  console.log('\n🏥 Testing health endpoint...');
  
  const req = http.get('http://localhost:3456/health', (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const health = JSON.parse(data);
        if (health.status === 'ok') {
          console.log('✅ Health check passed:', health);
          console.log('\n✅ All tests passed! Server starts correctly.');
          
          // Clean shutdown and exit successfully
          serverProcess.kill('SIGTERM');
          setTimeout(() => process.exit(0), 500);
        } else {
          console.error('❌ Health check returned unexpected status:', health);
          serverProcess.kill('SIGTERM');
          process.exit(1);
        }
      } catch (e) {
        console.error('❌ Health check returned invalid JSON:', data);
        serverProcess.kill('SIGTERM');
        process.exit(1);
      }
      
      // Clean shutdown
      // serverProcess.kill('SIGTERM');  // Moved inside success/failure handlers
    });
  });
  
  req.on('error', (err) => {
    console.error('❌ Health check request failed:', err.message);
    serverProcess.kill('SIGTERM');
    process.exit(1);
  });
  
  req.setTimeout(5000, () => {
    console.error('❌ Health check timeout');
    serverProcess.kill('SIGTERM');
    process.exit(1);
  });
}, 3000);

// Force kill after 15 seconds
setTimeout(() => {
  console.error('❌ Test timeout - forcing exit');
  serverProcess.kill('SIGKILL');
  process.exit(1);
}, 15000);