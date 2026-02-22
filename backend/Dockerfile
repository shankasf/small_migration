FROM node:20-slim

WORKDIR /app

# Install OpenSSL and other dependencies for Prisma
RUN apt-get update && apt-get install -y openssl libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy prisma schema and generate client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

EXPOSE 3001

CMD ["sh", "-c", "npx prisma db push --skip-generate && npm run dev"]
