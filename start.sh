#!/bin/bash
echo "Starting p3-bridge..."
sudo systemctl start p3-bridge
sudo systemctl status p3-bridge --no-pager
