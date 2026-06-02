# Backend image: Node for the API, Python + lxml + python-docx for the document engine,
# LibreOffice (+ matching fonts) to render the exact-looking PDF preview.
FROM node:20-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 python3-lxml python3-pip \
       libreoffice-writer \
       fonts-crosextra-carlito fonts-crosextra-caladea fonts-roboto fonts-liberation \
  && pip3 install --no-cache-dir --break-system-packages python-docx Pillow \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
ENV PYTHON_BIN=python3
ENV SOFFICE_BIN=soffice
EXPOSE 8080
CMD ["npm", "start"]
