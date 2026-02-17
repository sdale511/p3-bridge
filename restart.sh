#!/bin/bash
echo "Restarting p3-bridge..."
sudo systemctl restart p3-bridge
sleep 1
sudo systemctl status p3-bridge --no-pager
