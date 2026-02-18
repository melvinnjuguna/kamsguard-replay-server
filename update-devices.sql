-- update-devices.sql
-- Run this script to update your existing devices with device_type and max_cameras

-- Update multidetector device at 192.168.1.75
UPDATE devices 
SET device_type = 'multidetector', 
    max_cameras = 2 
WHERE ip_address = '192.168.1.75';

-- Update NVR device at 192.168.1.50
UPDATE devices 
SET device_type = 'nvr', 
    max_cameras = 16 
WHERE ip_address = '192.168.1.50';

-- Verify the updates
SELECT id, name, ip_address, device_type, max_cameras FROM devices;