const express = require('express');
const cors = require('cors');
const path = require('path');
const { migrate } = require('./db/schema');

migrate();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Enterprise Restaurant Management System' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/core'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/central', require('./routes/central'));

const PORT = process.env.PORT || 4001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Enterprise Restaurant Management System running on http://localhost:${PORT}`));
}

module.exports = app;
