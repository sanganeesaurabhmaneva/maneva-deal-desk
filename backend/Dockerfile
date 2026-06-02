# Backend image: Node to run the API, Python + lxml + python-docx to run the document engine.
FROM node:20-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-lxml python3-pip \
  && pip3 install --no-cache-dir --break-system-packages python-docx Pillow \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
ENV PYTHON_BIN=python3
EXPOSE 8080
CMD ["npm", "start"]
