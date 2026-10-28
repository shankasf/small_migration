# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage. The unprivileged nginx image runs as uid 101 and keeps its
# pid/temp paths under /tmp, so no root is required to serve the built assets.
FROM nginxinc/nginx-unprivileged:alpine

# Apply security fixes released after the nginx base image was published.
USER root
RUN apk upgrade --no-cache

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# The unprivileged base already defaults to uid 101; stating it explicitly
# documents the intent and keeps it from regressing if the base changes.
USER 101

EXPOSE 5173

CMD ["nginx", "-g", "daemon off;"]
