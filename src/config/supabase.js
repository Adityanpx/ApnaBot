const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const config = require('./env');

const supabase = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
    realtime: { transport: ws }
  }
);

module.exports = supabase;