World RNG Mix Demo
------------------
- Mixes multiple RNG sources (NIST beacon, drand, OpenSSL crypto.randomBytes, Fortuna-like AES-CTR, ChaCha20)
- Computes a combined SHA-256 hash and derives a 0-9 digit for each minute
- Emits preview at :20s and reveal at :00s via Socket.IO
- Tracks provider selection counts (for demonstration which sources were available/used)
- Deploy on Render/Replit. Build: npm install, Start: npm start
