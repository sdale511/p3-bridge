#!/bin/bash
echo "Stopping p3-bridge..."
sudo systemctl stop p3-bridge
sudo systemctl status p3-bridge --no-pager
