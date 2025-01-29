#!/bin/bash

# Install PM2 globally
npm install pm2 -g

# Create log directory
mkdir -p logs

# Start the application with PM2
pm2-runtime start ecosystem.config.js