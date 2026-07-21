FROM node:20-alpine AS runner

WORKDIR /app

# Install k6 for ARM64 (M1 Mac compatible)
RUN apk add --no-cache curl bash && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
      K6_ARCH="arm64"; \
    else \
      K6_ARCH="amd64"; \
    fi && \
    curl -L https://github.com/grafana/k6/releases/download/v0.51.0/k6-v0.51.0-linux-${K6_ARCH}.tar.gz \
      -o k6.tar.gz && \
    tar -xzf k6.tar.gz && \
    mv k6-v0.51.0-linux-${K6_ARCH}/k6 /usr/local/bin/k6 && \
    rm -rf k6.tar.gz k6-v0.51.0-linux-${K6_ARCH}

COPY load-test.js /scripts/load-test.js

ENV TARGET_URL=http://payment-service/api/checkout

ENTRYPOINT ["k6", "run", "/scripts/load-test.js"]
