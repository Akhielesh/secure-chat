FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Install wget for health checks
RUN apk add --no-cache wget

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S node -u 1001 -G nodejs

# Change ownership of app directory
RUN chown -R node:nodejs /app
USER node

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "server.js"]

