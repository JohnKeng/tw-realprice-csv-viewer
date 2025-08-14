
# Cloud Run-ready container with Node and unzip available
FROM node:20-slim

# Install unzip (needed by the app to extract the uploaded ZIP)
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip \
 && rm -rf /var/lib/apt/lists/*

# App setup
WORKDIR /usr/src/app
COPY . .

# Cloud Run expects the server to listen on $PORT (default 8080)
ENV NODE_ENV=production
ENV PORT=8080

# Use the non-root 'node' user for security
RUN chown -R node:node /usr/src/app
USER node

EXPOSE 3000

# Start the server
# Make sure server.js calls server.listen(process.env.PORT || 3000, '0.0.0.0')
CMD ["node", "server.js"]
