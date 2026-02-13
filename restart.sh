#!/bin/bash

# Kill any running webpack dev server
pkill -f "webpack"

# Load nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Use the correct Node version
nvm use

# Rebuild
echo "Building..."
npm run build

# Start the dev server
echo "Starting dev server..."
npm run dev
