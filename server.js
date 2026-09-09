import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const FLW_BASE = 'https://api.flutterwave.com/v3';

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} is not configured on the backend.`);
  }
}

function authToken(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

async function authUser(req) {
  const token = authToken(req);

  if (!token) return null;

  const { data, error } =
    await supabaseAdmin.auth.getUser(token);

  if (error || !data?.user) return null;

  return data.user;
}

async function profileById(id) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function profileByUsername(username) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('username', username)
    .maybeSingle();

  if (error) throw error;

  return data;
}

function profileData(profile) {
  const d =
    profile?.data && typeof profile.data === 'object'
      ? profile.data
      : {};

  d.deposits = Array.isArray(d.deposits) ? d.deposits : [];
  d.withdrawals = Array.isArray(d.withdrawals) ? d.withdrawals : [];
  d.transactions = Array.isArray(d.transactions) ? d.transactions : [];
  d.notifications = Array.isArray(d.notifications)
    ? d.notifications
    : [];

  d.assetBalance = Number(d.assetBalance || 0);
  d.earning = Number(d.earning || 0);
  d.affiliate = Number(d.affiliate || 0);
  d.totalWithdrawn = Number(d.totalWithdrawn || 0);

  return d;
}

async function saveProfileData(profile, data) {
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ data })
    .eq('id', profile.id);

  if (error) throw error;
}

async function requireAdmin(req) {
  const user = await authUser(req);

  if (!user) {
    throw Object.assign(
      new Error('Admin authentication required.'),
      { status: 401 }
    );
  }

  const profile = await profileById(user.id);

  if (!profile || profile.role !== 'admin') {
    throw Object.assign(
      new Error('Admin role required.'),
      { status: 403 }
    );
  }

  return { user, profile };
}

async function flwRequest(path, options = {}) {
  requireEnv('FLW_SECRET_KEY');

  const r = await fetch(`${FLW_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await r.text();

  let body = {};

  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!r.ok) {
    const err = new Error(
      body?.message ||
      body?.error ||
      `Flutterwave HTTP ${r.status}`
    );

    err.status = r.status;
    err.body = body;

    throw err;
  }

  return body;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'vertex-capital-flutterwave',
    time: new Date().toISOString()
  });
});

/* Create a Flutterwave Standard checkout link.
   Secret key never reaches the browser. */

app.post('/api/flutterwave/checkout', async (req, res) => {
  try {
    const user = await authUser(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Login required.'
      });
    }

    requireEnv('FLW_SECRET_KEY');

    const amount = Number(req.body?.amount);
    const kind = String(req.body?.kind || 'asset');

    if (!Number.isFinite(amount) || amount < 500) {
      return res.status(400).json({
        ok: false,
        error: 'Minimum deposit is ₦500.'
      });
    }

    if (!['asset', 'ads'].includes(kind)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid deposit type.'
      });
    }

    const profile = await profileById(user.id);

    if (!profile) {
      return res.status(404).json({
        ok: false,
        error: 'Profile not found.'
      });
    }

    const data = profileData(profile);

    const txRef =
      `vertex-${user.id.slice(0, 8)}-` +
      `${Date.now()}-` +
      `${crypto.randomBytes(3).toString('hex')}`;

    const deposit = {
      id: `flwdep_${Date.now()}`,
      tx_ref: txRef,
      amount,
      kind,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    data.deposits.unshift(deposit);

    await saveProfileData(profile, data);

    const frontendUrl =
      process.env.FRONTEND_URL ||
      'http://localhost:3000';

    const result = await flwRequest('/payments', {
      method: 'POST',
      body: JSON.stringify({
        tx_ref: txRef,
        amount,
        currency: 'NGN',
        redirect_url:
          `${frontendUrl}/?payment=complete&tx_ref=${encodeURIComponent(txRef)}`,
        customer: {
          email: user.email,
          name:
            profile.full_name ||
            profile.username ||
            user.email
        },
        customizations: {
          title: 'Vertex Capital',
          description: 'Vertex Capital Deposit',
          logo: ''
        },
        meta: {
          user_id: user.id,
          deposit_id: deposit.id,
          kind
        }
      })
    });

    const link = result?.data?.link;

    if (!link) {
      return res.status(502).json({
        ok: false,
        error: 'Flutterwave did not return a checkout link.'
      });
    }

    res.json({
      ok: true,
      link,
      tx_ref: txRef
    });

  } catch (e) {
    console.error('Flutterwave checkout error:', e);

    res.status(e.status || 500).json({
      ok: false,
      error: e.message || 'Unable to create payment.'
    });
  }
});

/* Flutterwave redirect helper */

app.get('/api/flutterwave/redirect', async (req, res) => {
  try {
    const txRef = String(req.query?.tx_ref || '');

    if (!txRef) {
      return res.status(400).send('Missing transaction reference.');
    }

    const frontendUrl =
      process.env.FRONTEND_URL ||
      'http://localhost:3000';

    res.redirect(
      `${frontendUrl}/?payment=complete&tx_ref=${encodeURIComponent(txRef)}`
    );

  } catch (e) {
    console.error('Redirect error:', e);
    res.status(500).send('Redirect failed.');
  }
});


/* Flutterwave webhook */

app.post('/api/flutterwave/webhook', async (req, res) => {
  try {
    const secretHash = process.env.FLW_SECRET_HASH;

    if (!secretHash) {
      console.error('FLW_SECRET_HASH is not configured.');
      return res.status(500).json({
        ok: false,
        error: 'Webhook secret not configured.'
      });
    }

    const incomingHash =
      req.headers['verif-hash'] ||
      req.headers['verif_hash'];

    if (
      !incomingHash ||
      String(incomingHash) !== String(secretHash)
    ) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid webhook signature.'
      });
    }

    const payload = req.body || {};
    const event = payload.event;
    const payment = payload.data || {};

    console.log(
      'Flutterwave webhook:',
      event,
      payment?.tx_ref,
      payment?.status
    );

    if (
      event !== 'charge.completed' &&
      event !== 'transfer.completed'
    ) {
      return res.json({
        ok: true,
        ignored: true
      });
    }

    const txRef = String(
      payment.tx_ref ||
      payment.reference ||
      ''
    );

    if (!txRef) {
      return res.json({
        ok: true,
        ignored: true
      });
    }

    const { data: profiles, error } =
      await supabaseAdmin
        .from('profiles')
        .select('*')
        .limit(1000);

    if (error) throw error;

    let targetProfile = null;
    let targetDeposit = null;

    for (const profile of profiles || []) {
      const data = profileData(profile);

      const deposit = data.deposits.find(
        d => String(d.tx_ref) === txRef
      );

      if (deposit) {
        targetProfile = profile;
        targetDeposit = deposit;
        break;
      }
    }

    if (!targetProfile || !targetDeposit) {
      console.warn(
        'Webhook transaction not found:',
        txRef
      );

      return res.json({
        ok: true,
        ignored: true
      });
    }

    const status = String(
      payment.status || ''
    ).toLowerCase();

    if (
      status !== 'successful' &&
      status !== 'completed'
    ) {
      targetDeposit.status = status || 'pending';

      const targetData =
        profileData(targetProfile);

      const index =
        targetData.deposits.findIndex(
          d => String(d.tx_ref) === txRef
        );

      if (index >= 0) {
        targetData.deposits[index] =
          targetDeposit;
      }

      await saveProfileData(
        targetProfile,
        targetData
      );

      return res.json({
        ok: true,
        status
      });
    }

    /* Prevent duplicate credit */

    if (targetDeposit.status === 'paid') {
      return res.json({
        ok: true,
        already_processed: true
      });
    }

    const targetData =
      profileData(targetProfile);

    const amount =
      Number(
        payment.amount ||
        targetDeposit.amount ||
        0
      );

    const kind =
      targetDeposit.kind || 'asset';

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid payment amount.'
      });
    }

    targetDeposit.status = 'paid';
    targetDeposit.paid_at =
      new Date().toISOString();

    targetDeposit.flutterwave_id =
      payment.id || null;

    targetDeposit.currency =
      payment.currency || 'NGN';

    if (kind === 'asset') {
      targetData.assetBalance =
        Number(targetData.assetBalance || 0) +
        amount;
    } else {
      targetData.earning =
        Number(targetData.earning || 0) +
        amount;
    }

    targetData.transactions.unshift({
      id: `txn_${Date.now()}`,
      type: 'deposit',
      wallet:
        kind === 'asset'
          ? 'asset'
          : 'earning',
      amount,
      reference: txRef,
      status: 'successful',
      created_at:
        new Date().toISOString()
    });

    const index =
      targetData.deposits.findIndex(
        d => String(d.tx_ref) === txRef
      );

    if (index >= 0) {
      targetData.deposits[index] =
        targetDeposit;
    }

    await saveProfileData(
      targetProfile,
      targetData
    );

    console.log(
      `Deposit credited: ${targetProfile.id} ₦${amount}`
    );

    return res.json({
      ok: true,
      credited: true
    });

  } catch (e) {
    console.error(
      'Flutterwave webhook error:',
      e
    );

    res.status(500).json({
      ok: false,
      error: 'Webhook processing failed.'
    });
  }
});


/* Authentication middleware */

async function requireUser(req, res, next) {
  try {
    const user = await authUser(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Authentication required.'
      });
    }

    req.user = user;
    req.profile = await profileById(user.id);

    if (!req.profile) {
      return res.status(404).json({
        ok: false,
        error: 'Profile not found.'
      });
    }

    next();

  } catch (e) {
    console.error('Authentication error:', e);

    res.status(401).json({
      ok: false,
      error: 'Invalid authentication.'
    });
  }
}


/* Current logged-in user */

app.get('/api/auth/me', requireUser, async (req, res) => {
  try {
    const data = profileData(req.profile);

    res.json({
      ok: true,
      user: req.user,
      profile: {
        ...req.profile,
        data
      }
    });

  } catch (e) {
    console.error('Profile error:', e);

    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


/* Public investment plans */

app.get('/api/investment-plans', async (_req, res) => {
  try {
    const { data, error } =
      await supabaseAdmin
        .from('investment_plans')
        .select('*')
        .eq('active', true)
        .order('investment_amount', {
          ascending: true
        });

    if (error) throw error;

    res.json({
      ok: true,
      plans: data || []
    });

  } catch (e) {
    console.error('Plans error:', e);

    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


/* Public support links */

app.get('/api/support', async (_req, res) => {
  try {
    const { data, error } =
      await supabaseAdmin
        .from('support_links')
        .select('*')
        .eq('active', true)
        .order('sort_order', {
          ascending: true
        });

    if (error) throw error;

    res.json({
      ok: true,
      links: data || []
    });

  } catch (e) {
    console.error('Support links error:', e);

    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});app.get('/api/banks', async (_req, res) => {
  res.json({
    ok: true,
    banks: [
      { code: '999', name: 'PalmPay' },
      { code: '100004', name: 'OPay' },
      { code: '120001', name: '9mobile 9Payment Service Bank' },
      { code: '100002', name: 'Kuda Bank' },
      { code: '50515', name: 'Moniepoint Microfinance Bank' },
      { code: '044', name: 'Access Bank' },
      { code: '058', name: 'GTBank' },
      { code: '033', name: 'United Bank for Africa' },
      { code: '057', name: 'Zenith Bank' },
      { code: '011', name: 'First Bank' },
      { code: '070', name: 'Fidelity Bank' },
      { code: '214', name: 'First City Monument Bank' },
      { code: '232', name: 'Sterling Bank' },
      { code: '221', name: 'Stanbic IBTC Bank' },
      { code: '032', name: 'Union Bank' },
      { code: '035', name: 'Wema Bank' },
      { code: '076', name: 'Polaris Bank' },
      { code: '050', name: 'Ecobank Nigeria' },
      { code: '101', name: 'Providus Bank' },
      { code: '215', name: 'Unity Bank' },
      { code: '301', name: 'Jaiz Bank' }
    ]
  });
});


/* Bank details */

app.get('/api/bank-details', requireUser, async (req, res) => {
  try {
    const { data, error } =
      await supabaseAdmin
        .from('bank_accounts')
        .select('*')
        .eq('user_id', req.user.id)
        .maybeSingle();

    if (error) throw error;

    res.json({
      ok: true,
      bank: data || null
    });

  } catch (e) {
    console.error('Bank details error:', e);

    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


app.post('/api/bank-details', requireUser, async (req, res) => {
  try {
    const bankName =
      String(req.body?.bank_name || '').trim();

    const accountNumber =
      String(req.body?.account_number || '').trim();

    const accountName =
      String(req.body?.account_name || '').trim();

    if (!bankName) {
      return res.status(400).json({
        ok: false,
        error: 'Bank name is required.'
      });
    }

    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({
        ok: false,
        error: 'Account number must contain 10 digits.'
      });
    }

    if (!accountName) {
      return res.status(400).json({
        ok: false,
        error: 'Account name is required.'
      });
    }

    const payload = {
      user_id: req.user.id,
      bank_name: bankName,
      account_number: accountNumber,
      account_name: accountName,
      updated_at: new Date().toISOString()
    };

    const { data, error } =
      await supabaseAdmin
        .from('bank_accounts')
        .upsert(payload, {
          onConflict: 'user_id'
        })
        .select('*')
        .single();

    if (error) throw error;

    res.json({
      ok: true,
      bank: data
    });

  } catch (e) {
    console.error('Save bank error:', e);

    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


/* Flutterwave account-name verification */

app.post('/api/bank-details/verify', requireUser, async (req, res) => {
  try {
    const accountNumber =
      String(req.body?.account_number || '').trim();

    const accountBank =
      String(req.body?.bank_code || '').trim();

    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({
        ok: false,
        error: 'Account number must contain 10 digits.'
      });
    }

    if (!accountBank) {
      return res.status(400).json({
        ok: false,
        error: 'Bank code is required.'
      });
    }

    const result = await flwRequest('/accounts/resolve', {
      method: 'POST',
      body: JSON.stringify({
        account_number: accountNumber,
        account_bank: accountBank
      })
    });

    res.json({
      ok: true,
      account: result?.data || null
    });

  } catch (e) {
    console.error('Account verification error:', e);

    res.status(e.status || 500).json({
      ok: false,
      error:
        e.message ||
        'Unable to verify bank account.'
    });
  }
});


/* Deposit history */

app.get('/api/deposits', requireUser, async (req, res) => {
  try {
    const data = profileData(req.profile);

    res.json({
      ok: true,
      deposits: data.deposits || []
    });

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


/* Create a deposit request */

app.post('/api/deposits', requireUser, async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const kind = String(req.body?.kind || 'asset');

    if (!Number.isFinite(amount) || amount < 500) {
      return res.status(400).json({
        ok: false,
        error: 'Minimum deposit is ₦500.'
      });
    }

    if (!['asset', 'ads'].includes(kind)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid deposit type.'
      });
    }

    const data = profileData(req.profile);

    const deposit = {
      id: `dep_${Date.now()}`,
      amount,
      kind,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    data.deposits.unshift(deposit);

    await saveProfileData(req.profile, data);

    res.json({
      ok: true,
      deposit
    });

  } catch (e) {
    console.error('Deposit error:', e);

    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


/* Withdrawals */

app.get('/api/withdrawals', requireUser, async (req, res) => {
  try {
    const data = profileData(req.profile);

    res.json({
      ok: true,
      withdrawals: data.withdrawals || []
    });

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


app.post('/api/withdrawals', requireUser, async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const wallet = String(
      req.body?.wallet || 'asset'
    );

    const minimums = {
      task: 500,
      affiliate: 1000,
      asset: 100
    };

    if (!minimums[wallet]) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid withdrawal wallet.'
      });
    }

    if (
      !Number.isFinite(amount) ||
      amount < minimums[wallet]
    ) {
      return res.status(400).json({
        ok: false,
        error:
          `Minimum ${wallet} withdrawal is ₦` +
          minimums[wallet].toLocaleString()
      });
    }

    const data = profileData(req.profile);

    const balanceKey =
      wallet === 'asset'
        ? 'assetBalance'
        : wallet === 'affiliate'
          ? 'affiliate'
          : 'earning';

    const balance =
      Number(data[balanceKey] || 0);

    if (amount > balance) {
      return res.status(400).json({
        ok: false,
        error: 'Insufficient balance.'
      });
    }

    const withdrawal = {
      id: `wd_${Date.now()}`,
      amount,
      wallet,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    data[balanceKey] = balance - amount;

    data.withdrawals.unshift(withdrawal);

    data.transactions.unshift({
      id: `txn_${Date.now()}`,
      type: 'withdrawal',
      wallet,
      amount: -amount,
      reference: withdrawal.id,
      status: 'pending',
      created_at: new Date().toISOString()
    });

    await saveProfileData(req.profile, data);

    res.json({
      ok: true,
      withdrawal
    });

  } catch (e) {
    console.error('Withdrawal error:', e);

    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


/* Transaction history */

app.get('/api/transactions', requireUser, async (req, res) => {
  try {
    const limit = Math.min(
      Number(req.query?.limit || 50),
      100
    );

    const data = profileData(req.profile);

    res.json({
      ok: true,
      transactions:
        (data.transactions || []).slice(0, limit)
    });

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

/* Check-in status */

app.get('/api/checkin/status', requireUser, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('checkins')
      .select('*')
      .eq('user_id', req.user.id)
      .order('claimed_at', { ascending: false })
      .limit(1);

    if (error) throw error;

    const latest = data?.[0] || null;

    res.json({
      ok: true,
      claimedToday: latest
        ? new Date(latest.claimed_at).toLocaleDateString(
            'en-CA',
            { timeZone: 'Africa/Lagos' }
          ) === new Date().toLocaleDateString(
            'en-CA',
            { timeZone: 'Africa/Lagos' }
          )
        : false,
      latest
    });

  } catch (e) {
    console.error('Check-in status error:', e);

    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


/* Claim daily check-in */

app.post('/api/checkin', requireUser, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.rpc(
      'claim_checkin',
      {
        p_user_id: req.user.id
      }
    );

    if (error) throw error;

    res.json({
      ok: true,
      result: data
    });

  } catch (e) {
    console.error('Check-in error:', e);

    res.status(400).json({
      ok: false,
      error: e.message
    });
  }
});


/* Referrals */

app.get('/api/referrals', requireUser, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('referral_rewards')
      .select('*')
      .eq('beneficiary_id', req.user.id)
      .order('created_at', {
        ascending: false
      });

    if (error) throw error;

    res.json({
      ok: true,
      referrals: data || []
    });

  } catch (e) {
    console.error('Referral error:', e);

    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


/* Investments */

app.get('/api/investments', requireUser, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('investments')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', {
        ascending: false
      });

    if (error) throw error;

    res.json({
      ok: true,
      investments: data || []
    });

  } catch (e) {
    console.error('Investment history error:', e);

    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


app.post('/api/investments', requireUser, async (req, res) => {
  try {
    const planId =
      String(req.body?.plan_id || '');

    if (!planId) {
      return res.status(400).json({
        ok: false,
        error: 'Investment plan is required.'
      });
    }

    const { data, error } =
      await supabaseAdmin.rpc(
        'create_investment',
        {
          p_user_id: req.user.id,
          p_plan_id: planId
        }
      );

    if (error) throw error;

    res.json({
      ok: true,
      investment: data
    });

  } catch (e) {
    console.error('Investment error:', e);

    res.status(400).json({
      ok: false,
      error: e.message
    });
  }
});


/* Change password */

app.post('/api/auth/change-password', requireUser, async (req, res) => {
  try {
    const newPassword =
      String(req.body?.new_password || '');

    if (newPassword.length < 6) {
      return res.status(400).json({
        ok: false,
        error:
          'New password must be at least 6 characters.'
      });
    }

    const { error } =
      await supabaseAdmin.auth.admin.updateUserById(
        req.user.id,
        {
          password: newPassword
        }
      );

    if (error) throw error;

    res.json({
      ok: true,
      message: 'Password changed successfully.'
    });

  } catch (e) {
    console.error('Password change error:', e);

    res.status(400).json({
      ok: false,
      error: e.message
    });
  }
});


/* Admin request list */

app.get('/api/admin/requests', async (req, res) => {
  try {
    await requireAdmin(req);

    const type =
      String(req.query?.type || 'all');

    const { data: profiles, error } =
      await supabaseAdmin
        .from('profiles')
        .select('*')
        .limit(1000);

    if (error) throw error;

    const requests = [];

    for (const profile of profiles || []) {
      const d = profileData(profile);

      if (type === 'deposit' || type === 'all') {
        for (const item of d.deposits || []) {
          requests.push({
            ...item,
            request_type: 'deposit',
            user_id: profile.id,
            username: profile.username,
            email: profile.email
          });
        }
      }

      if (type === 'withdrawal' || type === 'all') {
        for (const item of d.withdrawals || []) {
          requests.push({
            ...item,
            request_type: 'withdrawal',
            user_id: profile.id,
            username: profile.username,
            email: profile.email
          });
        }
      }
    }

    requests.sort(
      (a, b) =>
        new Date(b.created_at || 0) -
        new Date(a.created_at || 0)
    );

    res.json({
      ok: true,
      requests
    });

  } catch (e) {
    console.error('Admin request error:', e);

    res.status(e.status || 500).json({
      ok: false,
      error: e.message
    });
  }
});


/* Admin approve deposit */

app.post(
  '/api/admin/deposits/:id/approve',
  async (req, res) => {
    try {
      const { profile } = await requireAdmin(req);

      const { data, error } =
        await supabaseAdmin.rpc(
          'approve_deposit',
          {
            p_admin_id: profile.id,
            p_deposit_id: req.params.id
          }
        );

      if (error) throw error;

      res.json({
        ok: true,
        result: data
      });

    } catch (e) {
      console.error('Approve deposit error:', e);

      res.status(e.status || 400).json({
        ok: false,
        error: e.message
      });
    }
  }
);


/* Admin reject deposit */

app.post(
  '/api/admin/deposits/:id/reject',
  async (req, res) => {
    try {
      const { profile } = await requireAdmin(req);

      const { data, error } =
        await supabaseAdmin.rpc(
          'reject_deposit',
          {
            p_admin_id: profile.id,
            p_deposit_id: req.params.id
          }
        );

      if (error) throw error;

      res.json({
        ok: true,
        result: data
      });

    } catch (e) {
      console.error('Reject deposit error:', e);

      res.status(e.status || 400).json({
        ok: false,
        error: e.message
      });
    }
  }
);


/* Admin reject withdrawal */

app.post(
  '/api/admin/withdrawals/:id/reject',
  async (req, res) => {
    try {
      const { profile } = await requireAdmin(req);

      const { data, error } =
        await supabaseAdmin.rpc(
          'reject_withdrawal',
          {
            p_admin_id: profile.id,
            p_withdrawal_id: req.params.id
          }
        );

      if (error) throw error;

      res.json({
        ok: true,
        result: data
      });

    } catch (e) {
      console.error('Reject withdrawal error:', e);

      res.status(e.status || 400).json({
        ok: false,
        error: e.message
      });
    }
  }
);


/* Admin approve withdrawal */

app.post(
  '/api/admin/withdrawals/:id/approve',
  async (req, res) => {
    try {
      const { profile } = await requireAdmin(req);

      const { data, error } =
        await supabaseAdmin.rpc(
          'start_withdrawal_payout',
          {
            p_admin_id: profile.id,
            p_withdrawal_id: req.params.id
          }
        );

      if (error) throw error;

      res.json({
        ok: true,
        result: data
      });

    } catch (e) {
      console.error('Approve withdrawal error:', e);

      res.status(e.status || 400).json({
        ok: false,
        error: e.message
      });
    }
  }
);


/* Admin audit logs */

app.get('/api/admin/audit-logs', async (req, res) => {
  try {
    await requireAdmin(req);

    const { data, error } =
      await supabaseAdmin
        .from('audit_logs')
        .select('*')
        .order('created_at', {
          ascending: false
        })
        .limit(100);

    if (error) throw error;

    res.json({
      ok: true,
      logs: data || []
    });

  } catch (e) {
    console.error('Audit logs error:', e);

    res.status(e.status || 500).json({
      ok: false,
      error: e.message
    });
  }
});


/* Global error handler */

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);

  res.status(err.status || 500).json({
    ok: false,
    error: err.message || 'Internal server error.'
  });
});


/* Start server */

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Vertex Capital backend running on port ${PORT}`
  );
});
