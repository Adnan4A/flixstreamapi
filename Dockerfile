# Use Node 20 amd64
FROM --platform=linux/amd64 node:20

# Set working directory
WORKDIR /app

# Install Chrome dependencies and Google Chrome stable
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates fonts-liberation libnss3 libxss1 libasound2 libatk1.0-0 libcups2 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango1.0-0 \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome \
    NODE_ENV=production

# Copy and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app code
COPY . .

# Expose port for Cloud Run
EXPOSE 8080

# Start the server
CMD ["node", "server.js"]
