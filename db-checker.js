/**
 * NetVu Database Checker Tool
 * 
 * This tool helps you:
 * - Verify database schema is correct
 * - Check device configurations
 * - Validate device types and camera limits
 * - Identify potential issues
 * - Suggest fixes
 */

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

function log(message, color = 'white') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(70));
  log(title, 'cyan');
  console.log('='.repeat(70));
}

function logSuccess(message) {
  log(`✓ ${message}`, 'green');
}

function logWarning(message) {
  log(`⚠ ${message}`, 'yellow');
}

function logError(message) {
  log(`✗ ${message}`, 'red');
}

function logInfo(message) {
  log(`ℹ ${message}`, 'blue');
}

async function checkDatabase() {
  let db;
  let issues = [];
  let warnings = [];
  let suggestions = [];

  try {
    // ====== STEP 1: Connect to Database ======
    logSection('STEP 1: Database Connection');
    
    const dbPath = path.join(__dirname, 'netvu.db');
    logInfo(`Connecting to: ${dbPath}`);
    
    try {
      db = await open({
        filename: dbPath,
        driver: sqlite3.Database
      });
      logSuccess('Database connection established');
    } catch (err) {
      logError(`Failed to connect to database: ${err.message}`);
      logInfo('Please ensure netvu.db exists in the same directory as this script');
      process.exit(1);
    }

    // ====== STEP 2: Check Schema ======
    logSection('STEP 2: Schema Verification');
    
    // Check devices table
    logInfo('Checking devices table...');
    const devicesTableInfo = await db.all("PRAGMA table_info(devices)");
    
    if (devicesTableInfo.length === 0) {
      logError('devices table does not exist!');
      issues.push('devices table is missing');
    } else {
      logSuccess('devices table exists');
      
      // Check required columns
      const requiredColumns = [
        { name: 'id', type: 'INTEGER' },
        { name: 'name', type: 'TEXT' },
        { name: 'ip_address', type: 'TEXT' },
        { name: 'device_type', type: 'TEXT' },
        { name: 'max_cameras', type: 'INTEGER' },
        { name: 'status', type: 'TEXT' },
        { name: 'created_at', type: 'DATETIME' }
      ];
      
      console.log('\nColumn Check:');
      for (const reqCol of requiredColumns) {
        const found = devicesTableInfo.find(col => col.name === reqCol.name);
        if (found) {
          logSuccess(`  ${reqCol.name} (${found.type})`);
        } else {
          logError(`  ${reqCol.name} - MISSING`);
          issues.push(`Column '${reqCol.name}' is missing from devices table`);
        }
      }
    }

    // Check events table
    logInfo('\nChecking events table...');
    const eventsTableInfo = await db.all("PRAGMA table_info(events)");
    
    if (eventsTableInfo.length === 0) {
      logWarning('events table does not exist');
      warnings.push('events table is missing (non-critical)');
    } else {
      logSuccess('events table exists');
    }

    // ====== STEP 3: Check Devices ======
    logSection('STEP 3: Device Configuration Check');
    
    const devices = await db.all("SELECT * FROM devices ORDER BY id");
    
    if (devices.length === 0) {
      logWarning('No devices found in database');
      suggestions.push('Add devices using POST /api/devices endpoint');
    } else {
      logSuccess(`Found ${devices.length} device(s)`);
      
      console.log('\nDevice Details:');
      console.log('-'.repeat(70));
      
      for (const device of devices) {
        console.log();
        log(`Device #${device.id}: ${device.name}`, 'bright');
        console.log(`  IP Address:    ${device.ip_address}`);
        console.log(`  Device Type:   ${device.device_type || 'NOT SET'}`);
        console.log(`  Max Cameras:   ${device.max_cameras || 'NOT SET'}`);
        console.log(`  Status:        ${device.status || 'unknown'}`);
        console.log(`  Created:       ${device.created_at || 'unknown'}`);
        
        // Validate device configuration
        if (!device.device_type) {
          logWarning(`  → Device type not set (will default to 'nvr')`);
          warnings.push(`Device #${device.id} (${device.name}) has no device_type set`);
        } else if (!['nvr', 'multidetector'].includes(device.device_type)) {
          logError(`  → Invalid device type: ${device.device_type}`);
          issues.push(`Device #${device.id} has invalid device_type: ${device.device_type}`);
        }
        
        if (!device.max_cameras) {
          logWarning(`  → Max cameras not set (will default to 16)`);
          warnings.push(`Device #${device.id} (${device.name}) has no max_cameras set`);
        } else {
          // Validate max_cameras matches device type
          if (device.device_type === 'multidetector' && device.max_cameras > 2) {
            logError(`  → Multidetector should have max 2 cameras, but has ${device.max_cameras}`);
            issues.push(`Device #${device.id}: Multidetector with ${device.max_cameras} cameras (should be ≤2)`);
            suggestions.push(`UPDATE devices SET max_cameras = 2 WHERE id = ${device.id};`);
          }
          
          if (device.device_type === 'nvr' && device.max_cameras > 32) {
            logWarning(`  → NVR has ${device.max_cameras} cameras (unusually high)`);
          }
        }
      }
    }

    // ====== STEP 4: Check Events ======
    logSection('STEP 4: Events Data Check');
    
    try {
      const eventCount = await db.get("SELECT COUNT(*) as count FROM events");
      logSuccess(`Found ${eventCount.count} event(s) in database`);
      
      if (eventCount.count > 0) {
        // Check for orphaned events
        const orphanedEvents = await db.all(`
          SELECT DISTINCT e.device_ip 
          FROM events e 
          LEFT JOIN devices d ON e.device_ip = d.ip_address 
          WHERE d.ip_address IS NULL
        `);
        
        if (orphanedEvents.length > 0) {
          logWarning(`Found events for ${orphanedEvents.length} device(s) not in devices table:`);
          orphanedEvents.forEach(e => {
            console.log(`  - ${e.device_ip}`);
          });
          warnings.push(`${orphanedEvents.length} orphaned device IP(s) in events table`);
        } else {
          logSuccess('All events belong to valid devices');
        }
        
        // Show event distribution
        const eventsByDevice = await db.all(`
          SELECT d.name, d.ip_address, COUNT(*) as event_count
          FROM events e
          LEFT JOIN devices d ON e.device_ip = d.ip_address
          GROUP BY e.device_ip
          ORDER BY event_count DESC
        `);
        
        console.log('\nEvents per device:');
        eventsByDevice.forEach(row => {
          const deviceName = row.name || row.ip_address || 'Unknown';
          console.log(`  ${deviceName}: ${row.event_count} events`);
        });
      }
    } catch (err) {
      logWarning('Could not check events (table might not exist)');
    }

    // ====== STEP 5: Recommendations ======
    logSection('STEP 5: Recommendations & Fixes');
    
    if (issues.length === 0 && warnings.length === 0) {
      logSuccess('✓ Database is properly configured!');
      logSuccess('✓ All devices have correct types and limits');
      logSuccess('✓ Ready for production use');
    } else {
      if (issues.length > 0) {
        console.log();
        log('CRITICAL ISSUES FOUND:', 'red');
        issues.forEach((issue, i) => {
          logError(`${i + 1}. ${issue}`);
        });
      }
      
      if (warnings.length > 0) {
        console.log();
        log('WARNINGS:', 'yellow');
        warnings.forEach((warning, i) => {
          logWarning(`${i + 1}. ${warning}`);
        });
      }
      
      if (suggestions.length > 0) {
        console.log();
        log('SUGGESTED SQL FIXES:', 'cyan');
        console.log('\nRun these commands to fix issues:\n');
        suggestions.forEach(sql => {
          console.log(`  ${sql}`);
        });
        console.log();
      }
    }

    // ====== STEP 6: Quick Fix Script ======
    if (devices.length > 0) {
      logSection('STEP 6: Quick Fix Script');
      
      console.log('If you need to update devices, run these commands:\n');
      
      devices.forEach(device => {
        const needsUpdate = !device.device_type || !device.max_cameras;
        
        if (needsUpdate) {
          // Try to detect device type from name
          let suggestedType = 'nvr';
          let suggestedMax = 16;
          
          if (device.name.toLowerCase().includes('multidetector')) {
            suggestedType = 'multidetector';
            suggestedMax = 2;
          }
          
          console.log(`-- Update ${device.name} (ID: ${device.id})`);
          console.log(`UPDATE devices SET device_type = '${suggestedType}', max_cameras = ${suggestedMax} WHERE id = ${device.id};`);
          console.log();
        }
      });
      
      logInfo('Copy and paste the relevant SQL commands into:');
      console.log('  sqlite3 netvu.db < your-updates.sql');
      console.log('  OR');
      console.log('  sqlite3 netvu.db');
      console.log('  sqlite> [paste UPDATE commands]');
    }

    // ====== STEP 7: Summary ======
    logSection('SUMMARY');
    
    console.log();
    log(`Database Path: ${dbPath}`, 'bright');
    console.log(`Total Devices: ${devices.length}`);
    console.log(`Critical Issues: ${issues.length}`);
    console.log(`Warnings: ${warnings.length}`);
    console.log();
    
    if (issues.length === 0) {
      logSuccess('✓ Database is ready for use!');
    } else {
      logError('✗ Please fix critical issues before running the server');
    }
    
    await db.close();
    
    // Exit with appropriate code
    process.exit(issues.length > 0 ? 1 : 0);
    
  } catch (err) {
    logError(`Unexpected error: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

// ====== RUN CHECKER ======
console.log();
log('╔═══════════════════════════════════════════════════════════╗', 'cyan');
log('║       NetVu Database Configuration Checker                ║', 'cyan');
log('║       Version 1.0                                         ║', 'cyan');
log('╚═══════════════════════════════════════════════════════════╝', 'cyan');

checkDatabase();