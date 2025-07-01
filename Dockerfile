FROM ubuntu:24.04

# Set environment variables
ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/local/bin:${PATH}"

# Install system dependencies
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    pkg-config \
    libudev-dev \
    libssl-dev \
    ca-certificates \
    gnupg \
    lsb-release \
    software-properties-common \
    && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install Solana
RUN sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
RUN solana-keygen new --no-bip39-passphrase

# Install Yarn
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g yarn

# Install Anchor
RUN cargo install --git https://github.com/coral-xyz/anchor avm --force && \
    avm install latest && \
    avm use latest

# Install Docker (for Docker Compose)
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y docker-ce docker-ce-cli containerd.io

# Install Docker Compose
RUN curl -L "https://github.com/docker/compose/releases/download/v2.20.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose && \
    chmod +x /usr/local/bin/docker-compose

# Create docker group and add user (if group doesn't exist)
RUN groupadd -f docker && \
    usermod -aG docker root

# Install arcup (Arcium CLI will be installed at runtime)
RUN TARGET=x86_64_linux && \
    curl "https://bin.arcium.com/download/arcup_x86_64_linux_0.1.47" -o ~/.cargo/bin/arcup && \
    chmod +x ~/.cargo/bin/arcup

# Verify installations (excluding arcium since it's installed at runtime)
RUN solana --version && \
    anchor --version && \
    yarn --version && \
    docker --version && \
    docker-compose --version

# Set working directory
WORKDIR /workspace

RUN git clone https://github.com/cryptopapi997/confidential-transfer-arcium-demo.git

# Create startup script to start Docker daemon and install Arcium
RUN echo '#!/bin/bash\n\
service docker start\n\
\n\
# Wait for Docker to be ready\n\
echo "Waiting for Docker to be ready..."\n\
sleep 2\n\
# If Docker still not ready, try starting manually\n\
if ! docker ps > /dev/null 2>&1; then\n\
    echo "Docker service failed, trying manual start..."\n\
    dockerd &\n\
    sleep 5\n\
fi\n\
\n\
if ! command -v arcium &> /dev/null; then\n\
    echo "Installing Arcium CLI..."\n\
    arcup install\n\
fi\n\
exec "$@"' > /usr/local/bin/start.sh && \
    chmod +x /usr/local/bin/start.sh

# Default command
ENTRYPOINT ["/usr/local/bin/start.sh"]
CMD ["/bin/bash"] 