const express = require('express');
const admin = require('firebase-admin');
const { PubSub } = require('@google-cloud/pubsub');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

admin.initializeApp();
const db = admin.firestore();
const pubsub = new PubSub({ projectId: process.env.GCP_PROJECT_ID });

const app = express();
app.use(cors());
app.use(express.json());

// Auth middleware
async function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    req.user.org_id = decoded.org_id;
    req.user.uid = decoded.sub || decoded.uid;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// IAM middleware
async function iamMiddleware(req, res, next) {
  try {
    const roleDoc = await db
      .collection('organizations')
      .doc(req.user.org_id)
      .collection('team_roles')
      .doc(req.user.uid)
      .get();
    
    if (!roleDoc.exists) {
      return res.status(403).json({ error: 'No role in organization' });
    }
    
    const roleData = roleDoc.data();
    req.user.role = roleData.role_name;
    req.user.permissions = roleData.permissions || [];
    next();
  } catch (error) {
    res.status(500).json({ error: 'IAM check failed' });
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Create booking
app.post(
  '/api/organizations/:orgId/bookings',
  authMiddleware,
  iamMiddleware,
  async (req, res) => {
    try {
      const { orgId } = req.params;
      const { service_variant_ref, client_email, client_name, client_phone, scheduled_at, duration_minutes, price, notes } = req.body;

      if (req.user.org_id !== orgId) return res.status(403).json({ error: 'Unauthorized' });

      const orgDoc = await db.collection('organizations').doc(orgId).collection('config').doc('config').get();
      const orgData = orgDoc.data() || {};
      
      let commissionAmount = 0;
      if (orgData.commission_model === 'percentage') {
        commissionAmount = (price * (orgData.commission_percentage || 0)) / 100;
      } else if (orgData.commission_model === 'fixed') {
        commissionAmount = orgData.commission_fixed || 0;
      }

      const bookingRef = db.collection('organizations').doc(orgId).collection('bookings').doc();
      const bookingData = {
        service_variant_ref,
        client_email,
        client_name,
        client_phone,
        scheduled_at: new Date(scheduled_at),
        duration_minutes,
        price: parseFloat(price),
        status: 'pending',
        commission_percentage: orgData.commission_percentage || 0,
        commission_amount: commissionAmount,
        notes,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      };

      await bookingRef.set(bookingData);

      // Publish event
      await pubsub.topic('booking-created').publish(Buffer.from(JSON.stringify({
        booking_id: bookingRef.id,
        org_id: orgId,
        client_email,
        client_name,
        price,
        commission_amount: commissionAmount,
        scheduled_at
      })));

      res.status(201).json({ id: bookingRef.id, ...bookingData });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: 'Failed to create booking' });
    }
  }
);

// Send invitation
app.post(
  '/api/organizations/:orgId/invitations',
  authMiddleware,
  iamMiddleware,
  async (req, res) => {
    try {
      const { orgId } = req.params;
      const { email, first_name, role } = req.body;

      if (req.user.org_id !== orgId) return res.status(403).json({ error: 'Unauthorized' });

      const roleDoc = await db
        .collection('organizations')
        .doc(orgId)
        .collection('roles')
        .where('name', '==', role)
        .limit(1)
        .get();

      if (roleDoc.empty) return res.status(400).json({ error: 'Invalid role' });

      const roleName = roleDoc.docs[0].data().name;
      const token = require('crypto').randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

      const inviteRef = db.collection('organizations').doc(orgId).collection('invitations').doc();
      const inviteData = {
        email,
        first_name,
        role_name: roleName,
        token,
        expires_at: expiresAt,
        status: 'pending',
        invited_by: req.user.uid,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      };

      await inviteRef.set(inviteData);

      // Publish event
      await pubsub.topic('invitation-sent').publish(Buffer.from(JSON.stringify({
        invitation_id: inviteRef.id,
        org_id: orgId,
        email,
        first_name,
        token,
        expires_at: expiresAt.toISOString(),
        role: roleName
      })));

      res.status(201).json({
        id: inviteRef.id,
        ...inviteData,
        invitation_link: `${process.env.FRONTEND_URL}/accept-invitation?token=${token}`
      });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: 'Failed to create invitation' });
    }
  }
);

// Stripe webhook
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const stripe = require('stripe')(process.env.STRIPE_API_KEY);
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    
    await pubsub.topic('stripe-webhook').publish(Buffer.from(JSON.stringify({
      event_type: event.type,
      event_id: event.id,
      data: event.data.object
    })));

    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook error:', error);
    res.status(400).json({ error: 'Webhook signature verification failed' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Calandr backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`GCP Project: ${process.env.GCP_PROJECT_ID}`);
});

module.exports = app;
