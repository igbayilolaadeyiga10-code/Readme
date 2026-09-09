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
  const { data, error } =
    await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', id)
      .maybeSingle();

  if (error) throw error;

  return data;
}

async function profileByUsername(username) {
  const { data, error } =
    await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('username', username)
      .maybeSingle();

  if (error) throw error;

  return data;
}

function profileData(profile) {
  const d =
    profile?.data &&
    typeof profile.data === 'object'
      ? profile.data
      : {};

  d.deposits = Array.isArray(d.deposits)
    ? d.deposits
    : [];

  d.withdrawals = Array.isArray(d.withdrawals)
    ? d.withdrawals
    : [];

  d.transactions = Array.isArray(d.transactions)
    ? d.transactions
    : [];

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
  const { error } =
    await supabaseAdmin
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
      Authorization:
        `Bearer ${process.env.FLW_SECRET_KEY}`,
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


/* =========================
   HEALTH CHECK
========================= */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'vertex-capital-flutterwave',
    time: new Date().toISOString()
  });
});


/* =========================
   FLUTTERWAVE CHECKOUT
========================= */

app.post(
  '/api/flutterwave/checkout',
  async (req, res) => {
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
      const kind = String(
        req.body?.kind || 'asset'
      );

      if (
        !Number.isFinite(amount) ||
        amount < 500
      ) {
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

      const profile =
        await profileById(user.id);

      if (!profile) {
        return res.status(404).json({
          ok: false,
          error: 'Profile not found.'
        });
      }

      const data = profileData(profile);

      const txRef =
        `vertex-${user.id.slice(0, 8)}-${Date.now()}-${crypto
          .randomBytes(3)
          .toString('hex')}`;

      const deposit = {
        id: `flwdep_${Date.now()}`,
        tx_ref: txRef,
        amount,
        kind,
        status: 'pending',
        paymentMethod: 'flutterwave',
        date: new Date().toISOString(),
        transactionId: ''
      };

      data.deposits.unshift(deposit);

      data.transactions.unshift({
        id: `tx_${Date.now()}`,
        requestId: deposit.id,
        type: 'Flutterwave Deposit',
        amount,
        balance:
          kind === 'ads'
            ? 'Ads Balance'
            : 'Asset Balance',
        status: 'pending',
        date: new Date().toISOString()
      });

      await saveProfileData(
        profile,
        data
      );

      const callback =
        `${process.env.BACKEND_PUBLIC_URL || ''}/api/flutterwave/redirect`;

      const out = await flwRequest(
        '/payments',
        {
          method: 'POST',
          body: JSON.stringify({
            tx_ref: txRef,
            amount,
            currency: 'NGN',
            redirect_url: callback,

            customer: {
              email:
                profile.email ||
                user.email,

              name:
                profile.username ||
                user.user_metadata?.username ||
                'Vertex Capital User',

              phonenumber:
                profile.phone || ''
            },

            customizations: {
              title: 'VERTEX CAPITAL',
              description:
                'Vertex Capital deposit'
            },

            meta: {
              user_id: user.id,
              username:
                profile.username || '',
              kind,
              tx_ref: txRef
            }
          })
        }
      );

      return res.json({
        ok: true,
        link:
          out?.data?.link ||
          out?.data?.checkout_url ||
          null,
        tx_ref: txRef
      });

    } catch (e) {
      console.error(
        'checkout error',
        e
      );

      return res.status(
        e.status || 500
      ).json({
        ok: false,
        error:
          e.message ||
          'Checkout creation failed.'
      });
    }
  }
);


/* =========================
   FLUTTERWAVE REDIRECT
========================= */

app.get(
  '/api/flutterwave/redirect',
  (req, res) => {
    const ref = encodeURIComponent(
      String(req.query?.tx_ref || '')
    );

    const site =
      String(
        process.env.FRONTEND_URL || ''
      ).replace(/\/$/, '');

    res.redirect(
      `${site || '/'}?payment=return&tx_ref=${ref}`
    );
  }
);


/* =========================
   VERIFY PAYMENT
========================= */

app.get(
  '/api/flutterwave/verify/:transactionId',
  async (req, res) => {
    try {
      const out =
        await flwRequest(
          `/transactions/${encodeURIComponent(
            req.params.transactionId
          )}/verify`,
          {
            method: 'GET'
          }
        );

      res.json({
        ok: true,
        data: out?.data || null
      });

    } catch (e) {
      res.status(
        e.status || 500
      ).json({
        ok: false,
        error: e.message
      });
    }
  }
);


/* =========================
   WEBHOOK SECURITY
========================= */

function validWebhook(req) {
  const secret =
    process.env.FLW_SECRET_HASH || '';

  if (!secret) return false;

  const signature = String(
    req.headers['flutterwave-signature'] ||
    req.headers['verif-hash'] ||
    ''
  );

  if (!signature) return false;

  if (
    req.headers['flutterwave-signature']
  ) {
    const expected =
      crypto
        .createHmac('sha256', secret)
        .update(req.rawBody || '')
        .digest('base64');

    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  }

  return signature === secret;
}


/* =========================
   PROCESS PAYMENT WEBHOOK
========================= */

async function processPaymentWebhook(
  payload
) {
  const p =
    payload?.data || {};

  const txRef =
    p.tx_ref ||
    p.reference;

  const transactionId =
    p.id;

  if (
    !txRef ||
    !transactionId
  ) {
    return;
  }

  const verified =
    await flwRequest(
      `/transactions/${encodeURIComponent(
        transactionId
      )}/verify`,
      {
        method: 'GET'
      }
    );

  const v =
    verified?.data || {};

  const status =
    String(v.status || '')
      .toLowerCase();

  if (
    status !== 'successful' &&
    status !== 'succeeded'
  ) {
    return;
  }

  const {
    data: rows,
    error
  } =
    await supabaseAdmin
      .from('profiles')
      .select('*');

  if (error) throw error;

  const profile =
    (rows || []).find(r => {
      const d =
        r?.data || {};

      return (
        Array.isArray(d.deposits) &&
        d.deposits.some(
          x => x.tx_ref === txRef
        )
      );
    });

  if (!profile) return;

  const data =
    profileData(profile);

  const dep =
    data.deposits.find(
      x => x.tx_ref === txRef
    );

  if (
    !dep ||
    dep.status === 'approved'
  ) {
    return;
  }

  const expected =
    Number(dep.amount);

  if (
    Number(v.amount) !== expected ||
    String(v.currency || '')
      .toUpperCase() !== 'NGN' ||
    String(
      v.tx_ref ||
      v.reference
    ) !== String(txRef)
  ) {
    dep.status = 'failed';

    await saveProfileData(
      profile,
      data
    );

    return;
  }

  dep.status = 'approved';

  dep.transactionId =
    String(transactionId);

  dep.approvedDate =
    new Date().toISOString();

  if (dep.kind === 'ads') {
    data.adBalance =
      Number(data.adBalance || 0) +
      expected;
  } else {
    data.assetBalance =
      Number(data.assetBalance || 0) +
      expected;
  }

  data.transactions.unshift({
    id: `tx_${Date.now()}`,
    requestId: dep.id,
    type:
      'Flutterwave Deposit Approved',
    amount: expected,
    balance:
      dep.kind === 'ads'
        ? 'Ads Balance'
        : 'Asset Balance',
    status: 'approved',
    date:
      new Date().toISOString(),
    transactionId
  });

  await saveProfileData(
    profile,
    data
  );
}


/* =========================
   PROCESS TRANSFER WEBHOOK
========================= */

async function processTransferWebhook(
  payload
) {
  const d =
    payload?.data || {};

  const reference =
    d.reference ||
    d.meta?.reference;

  const status =
    String(d.status || '')
      .toUpperCase();

  if (!reference) return;

  const {
    data: rows,
    error
  } =
    await supabaseAdmin
      .from('profiles')
      .select('*');

  if (error) throw error;

  const profile =
    (rows || []).find(r =>
      Array.isArray(
        r?.data?.withdrawals
      ) &&
      r.data.withdrawals.some(
        w =>
          w.transferReference ===
          reference
      )
    );

  if (!profile) return;

  const data =
    profileData(profile);

  const w =
    data.withdrawals.find(
      x =>
        x.transferReference ===
        reference
    );

  if (
    !w ||
    [
      'approved',
      'failed',
      'rejected'
    ].includes(
      String(w.status)
    )
  ) {
    return;
  }

  if (
    status === 'SUCCESSFUL' ||
    status === 'SUCCESS' ||
    status === 'SUCCEEDED'
  ) {
    w.status = 'approved';

    w.transferId =
      String(
        d.id ||
        w.transferId ||
        ''
      );

    w.completedDate =
      new Date().toISOString();

    data.totalWithdrawn +=
      Number(w.amount || 0);

    data.transactions.unshift({
      id: `tx_${Date.now()}`,
      requestId: w.id,
      type: 'Withdrawal Paid',
      amount:
        -Number(w.amount || 0),
      balance:
        w.type === 'task'
          ? 'Task Balance'
          : w.type === 'affiliate'
            ? 'Affiliate Balance'
            : 'Asset Balance',
      status: 'approved',
      date:
        new Date().toISOString(),
      transferReference:
        reference
    });

  } else if (
    status === 'FAILED' ||
    status === 'FAIL' ||
    status === 'CANCELLED'
  ) {
    w.status = 'failed';

    const field =
      w.type === 'task'
        ? 'earning'
        : w.type === 'affiliate'
          ? 'affiliate'
          : 'assetBalance';

    data[field] =
      Number(data[field] || 0) +
      Number(w.amount || 0);

    data.transactions.unshift({
      id: `tx_${Date.now()}`,
      requestId: w.id,
      type:
        'Withdrawal Failed — Refunded',
      amount:
        Number(w.amount || 0),
      balance: field,
      status: 'approved',
      date:
        new Date().toISOString(),
      transferReference:
        reference
    });
  }

  await saveProfileData(
    profile,
    data
  );
}


/* =========================
   FLUTTERWAVE WEBHOOK
========================= */

app.post(
  '/api/flutterwave/webhook',
  async (req, res) => {
    try {
      if (!validWebhook(req)) {
        return res
          .status(401)
          .send('Invalid webhook signature');
      }

      res
        .status(200)
        .send('OK');

      const type =
        String(
          req.body?.type ||
          req.body?.['event.type'] ||
          ''
        ).toLowerCase();

      if (
        type.includes('transfer') ||
        req.body?.data?.type === 'BANK'
      ) {
        await processTransferWebhook(
          req.body
        );
      } else {
        await processPaymentWebhook(
          req.body
        );
      }

    } catch (e) {
      console.error(
        'webhook processing error',
        e
      );
    }
  }
);


/* =========================
   FLUTTERWAVE PAYOUT
========================= */

app.post(
  '/api/flutterwave/payout',
  async (req, res) => {
    try {
      await requireAdmin(req);

      requireEnv(
        'FLW_SECRET_KEY'
      );

      const username =
        String(
          req.body?.username || ''
        );

      const withdrawalId =
        String(
          req.body?.id || ''
        );

      if (
        !username ||
        !withdrawalId
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'username and withdrawal id are required.'
        });
      }

      const profile =
        await profileByUsername(
          username
        );

      if (!profile) {
        return res.status(404).json({
          ok: false,
          error:
            'User profile not found.'
        });
      }

      const data =
        profileData(profile);

      const w =
        data.withdrawals.find(
          x =>
            String(x.id) ===
            withdrawalId
        );

      if (!w) {
        return res.status(404).json({
          ok: false,
          error:
            'Withdrawal not found.'
        });
      }

      if (
        w.status !== 'pending'
      ) {
        return res.status(409).json({
          ok: false,
          error:
            `Withdrawal is already ${w.status}.`
        });
      }

      if (
        !w.bank?.account ||
        !w.bank?.code
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'User bank details need a Flutterwave bank code and account number.'
        });
      }

      const reference =
        `vertex-wd-${profile.id.slice(0, 8)}-${Date.now()}-${crypto
          .randomBytes(3)
          .toString('hex')}`;

      const callbackUrl =
        `${process.env.BACKEND_PUBLIC_URL || ''}/api/flutterwave/webhook`;

      const out =
        await flwRequest(
          '/transfers',
          {
            method: 'POST',

            body: JSON.stringify({
              account_bank:
                String(
                  w.bank.code
                ),

              account_number:
                String(
                  w.bank.account
                ),

              amount:
                Number(w.amount),

              currency:
                'NGN',

              beneficiary_name:
                String(
                  w.bank.name
                ),

              narration:
                'VERTEX CAPITAL withdrawal',

              reference,

              callback_url:
                callbackUrl
            })
          }
        );

      w.status =
        'processing';

      w.transferReference =
        reference;

      w.transferId =
        String(
          out?.data?.id || ''
        );

      w.flwStatus =
        out?.data?.status ||
        out?.status ||
        'NEW';

      w.approvedDate =
        new Date().toISOString();

      await saveProfileData(
        profile,
        data
      );

      res.json({
        ok: true,
        status: 'processing',
        reference,
        transferId:
          w.transferId,
        flwStatus:
          w.flwStatus
      });

    } catch (e) {
      console.error(
        'payout error',
        e
      );

      res.status(
        e.status || 500
      ).json({
        ok: false,
        error:
          e.message ||
          'Payout failed.'
      });
    }
  }
);


/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Vertex Capital Flutterwave backend listening on ${PORT}`
    );
  }
);
