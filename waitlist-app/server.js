const express = require('express');
const cors = require('cors');
const path = require('path');
const { migrate } = require('./db/schema');

migrate();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Pho Ha Noi — Waitlist' }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/waitlist', require('./routes/waitlist'));

const PORT = process.env.PORT || 4002;
if (require.main === module) app.listen(PORT, () => console.log(`Pho Ha Noi Waitlist running on http://localhost:${PORT}`));

module.exports = app;
