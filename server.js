const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// Config from environment variables
const QB_CLIENT_ID = process.env.QB_CLIENT_ID;
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const QB_REDIRECT_URI = process.env.QB_REDIRECT_URI || 'https://airforge-qb-server.railway.app/callback';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://airforge.vercel.app';

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_BASE_URL = 'https://sandbox-quickbooks.api.intuit.com'; // Change to https://quickbooks.api.intuit.com for production
const QB_SCOPE = 'com.intuit.quickbooks.accounting';

// ── STEP 1: Start OAuth flow ──────────────────────────
// Called from AirForge frontend — redirects user to QuickBooks
app.get('/qb/connect', (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: 'company_id required' });

  const state = Buffer.from(JSON.stringify({ company_id })).toString('base64');
  const params = new URLSearchParams({
    client_id: QB_CLIENT_ID,
    scope: QB_SCOPE,
    redirect_uri: QB_REDIRECT_URI,
    response_type: 'code',
    state,
  });

  res.redirect(`${QB_AUTH_URL}?${params}`);
});

// ── STEP 2: Handle OAuth callback from QuickBooks ─────
app.get('/callback', async (req, res) => {
  const { code, state, realmId } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state');

  let company_id;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
    company_id = decoded.company_id;
  } catch {
    return res.status(400).send('Invalid state');
  }

  try {
    // Exchange code for tokens
    const credentials = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await axios.post(QB_TOKEN_URL,
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: QB_REDIRECT_URI }),
      { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const expires_at = new Date(Date.now() + expires_in * 1000).toISOString();

    // Store tokens in Supabase
    await sb.from('qb_connections').upsert({
      company_id,
      realm_id: realmId,
      access_token,
      refresh_token,
      expires_at,
      connected_at: new Date().toISOString(),
    }, { onConflict: 'company_id' });

    res.redirect(`${FRONTEND_URL}/app?qb=connected`);
  } catch (err) {
    console.error('QB callback error:', err.response?.data || err.message);
    res.redirect(`${FRONTEND_URL}/app?qb=error`);
  }
});

// ── STEP 3: Refresh token if needed ───────────────────
async function getValidToken(company_id) {
  const { data: conn } = await sb.from('qb_connections').select('*').eq('company_id', company_id).single();
  if (!conn) throw new Error('Not connected to QuickBooks');

  // Check if token expired
  if (new Date(conn.expires_at) < new Date(Date.now() + 60000)) {
    const credentials = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await axios.post(QB_TOKEN_URL,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refresh_token }),
      { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const expires_at = new Date(Date.now() + expires_in * 1000).toISOString();
    await sb.from('qb_connections').update({ access_token, refresh_token, expires_at }).eq('company_id', company_id);
    return { access_token, realm_id: conn.realm_id };
  }

  return { access_token: conn.access_token, realm_id: conn.realm_id };
}

// ── STEP 4: Send invoice to QuickBooks ────────────────
app.post('/qb/invoice', async (req, res) => {
  const { company_id, job_id } = req.body;
  if (!company_id || !job_id) return res.status(400).json({ error: 'company_id and job_id required' });

  try {
    const { access_token, realm_id } = await getValidToken(company_id);

    // Fetch job from Supabase
    const { data: job } = await sb.from('jobs')
      .select('*, customers(name, address), technicians(name)')
      .eq('id', job_id).single();

    if (!job) return res.status(404).json({ error: 'Job not found' });

    const customerName = job.customers?.name || 'Unknown Customer';
    const baseUrl = `${QB_BASE_URL}/v3/company/${realm_id}`;
    const headers = {
      Authorization: `Bearer ${access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    // Find or create customer in QuickBooks
    let qbCustomerId = null;
    const custSearch = await axios.get(
      `${baseUrl}/query?query=select * from Customer where DisplayName = '${customerName.replace(/'/g, "\\'")}'`,
      { headers }
    );
    const existingCust = custSearch.data.QueryResponse?.Customer?.[0];

    if (existingCust) {
      qbCustomerId = existingCust.Id;
    } else {
      const newCust = await axios.post(`${baseUrl}/customer`, {
        DisplayName: customerName,
        BillAddr: job.customers?.address ? { Line1: job.customers.address } : undefined,
      }, { headers });
      qbCustomerId = newCust.data.Customer.Id;
    }

    // Build invoice line items
    const lineItems = [
      {
        Amount: (job.total_charged || 0) - (job.parts_cost || 0),
        DetailType: 'SalesItemLineDetail',
        Description: `${job.job_type} - Technician: ${job.technicians?.name || 'Unknown'}`,
        SalesItemLineDetail: { UnitPrice: (job.total_charged || 0) - (job.parts_cost || 0), Qty: 1 }
      }
    ];

    if (job.parts_cost > 0) {
      lineItems.push({
        Amount: job.parts_cost,
        DetailType: 'SalesItemLineDetail',
        Description: 'Parts and materials',
        SalesItemLineDetail: { UnitPrice: job.parts_cost, Qty: 1 }
      });
    }

    // Create invoice
    const invoiceRes = await axios.post(`${baseUrl}/invoice`, {
      Line: lineItems,
      CustomerRef: { value: qbCustomerId },
      TxnDate: job.date,
      PrivateNote: job.tech_notes || '',
    }, { headers });

    const qbInvoice = invoiceRes.data.Invoice;

    // Save QB invoice ID back to job
    await sb.from('jobs').update({ qb_invoice_id: qbInvoice.Id }).eq('id', job_id);

    res.json({ success: true, invoice_id: qbInvoice.Id, invoice_num: qbInvoice.DocNumber });
  } catch (err) {
    console.error('QB invoice error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.Fault?.Error?.[0]?.Message || err.message });
  }
});

// ── STEP 5: Check connection status ───────────────────
app.get('/qb/status', async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: 'company_id required' });
  const { data: conn } = await sb.from('qb_connections').select('connected_at, realm_id').eq('company_id', company_id).single();
  res.json({ connected: !!conn, connected_at: conn?.connected_at || null });
});

// ── STEP 6: Disconnect ────────────────────────────────
app.delete('/qb/disconnect', async (req, res) => {
  const { company_id } = req.body;
  if (!company_id) return res.status(400).json({ error: 'company_id required' });
  await sb.from('qb_connections').delete().eq('company_id', company_id);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AirForge QB server running on port ${PORT}`));
