#!/bin/bash
echo "Tailing logs..."
sudo journalctl -u p3-bridge -f
