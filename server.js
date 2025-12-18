// server.js - Backend for Portfolio Poker Stripe Integration
// Deploy this to Render, Railway, or any Node.js hosting

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_URL || '*', // Change to your domain in production
    credentials: true
}));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'Portfolio Poker Payment Server Running' });
});

// ===== ONE-TIME PURCHASES =====

// Create checkout session for card packs
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { productType, userId } = req.body;

        // Define products
        const products = {
            'elite-pack': {
                name: 'Elite Card Pack',
                description: '10 Cards with 1 Epic Guaranteed',
                amount: 499, // $4.99 in cents
                quantity: 1,
                metadata: { type: 'card_pack', tier: 'elite', cards: 10 }
            },
            'tournament-entry': {
                name: 'Tournament Entry',
                description: 'Enter tournament with 1000 gem prize pool',
                amount: 99, // $0.99 in cents
                quantity: 1,
                metadata: { type: 'tournament', entry: 'standard' }
            },
            'gems-1000': {
                name: '1000 Gems Bundle',
                description: '1000 premium gems for card purchases',
                amount: 999, // $9.99 in cents
                quantity: 1,
                metadata: { type: 'currency', gems: 1000 }
            },
            'gems-500': {
                name: '500 Gems Bundle',
                description: '500 premium gems (20% bonus)',
                amount: 399, // $3.99 in cents
                quantity: 1,
                metadata: { type: 'currency', gems: 500 }
            },
            'gems-100': {
                name: '100 Gems Bundle',
                description: '100 premium gems starter pack',
                amount: 99, // $0.99 in cents
                quantity: 1,
                metadata: { type: 'currency', gems: 100 }
            }
        };

        const product = products[productType];
        if (!product) {
            return res.status(400).json({ error: 'Invalid product type' });
        }

        // Create Stripe checkout session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: product.name,
                            description: product.description,
                        },
                        unit_amount: product.amount,
                    },
                    quantity: product.quantity,
                }
            ],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/portfolio-poker.html`,
            client_reference_id: userId, // Your user ID
            metadata: product.metadata
        });

        res.json({ 
            sessionId: session.id,
            url: session.url 
        });

    } catch (error) {
        console.error('Checkout session error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===== SUBSCRIPTION (PREMIUM) =====

// Create subscription checkout
app.post('/create-subscription', async (req, res) => {
    try {
        const { userId, email } = req.body;

        // Create or retrieve customer
        let customer;
        try {
            const customers = await stripe.customers.list({
                email: email,
                limit: 1
            });
            
            if (customers.data.length > 0) {
                customer = customers.data[0];
            } else {
                customer = await stripe.customers.create({
                    email: email,
                    metadata: { userId: userId }
                });
            }
        } catch (error) {
            console.error('Customer creation error:', error);
            return res.status(500).json({ error: 'Failed to create customer' });
        }

        // Create checkout session for subscription
        const session = await stripe.checkout.sessions.create({
            customer: customer.id,
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'Portfolio Poker Premium',
                            description: 'Unlock all cards, 2x gems, no ads',
                        },
                        unit_amount: 499, // $4.99
                        recurring: {
                            interval: 'month',
                        },
                    },
                    quantity: 1,
                }
            ],
            mode: 'subscription',
            success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/portfolio-poker.html`,
            metadata: {
                userId: userId,
                type: 'premium_subscription'
            }
        });

        res.json({ 
            sessionId: session.id,
            url: session.url 
        });

    } catch (error) {
        console.error('Subscription error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Cancel subscription
app.post('/cancel-subscription', async (req, res) => {
    try {
        const { subscriptionId } = req.body;

        const subscription = await stripe.subscriptions.update(
            subscriptionId,
            { cancel_at_period_end: true }
        );

        res.json({ 
            success: true,
            subscription: subscription 
        });

    } catch (error) {
        console.error('Cancellation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===== VERIFY PURCHASE =====

// Verify payment after redirect
app.post('/verify-purchase', async (req, res) => {
    try {
        const { sessionId } = req.body;

        // Retrieve the session
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === 'paid') {
            // Payment successful - return what to grant
            const metadata = session.metadata || {};
            
            res.json({
                success: true,
                paid: true,
                userId: session.client_reference_id,
                productType: metadata.type,
                productDetails: metadata,
                amount: session.amount_total / 100 // Convert cents to dollars
            });
        } else {
            res.json({
                success: false,
                paid: false,
                status: session.payment_status
            });
        }

    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===== WEBHOOKS =====

// Stripe webhook endpoint (for real-time payment events)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            console.log('Payment successful:', session.id);
            
            // TODO: Update your database to grant items
            // Example:
            // await grantPurchase(session.client_reference_id, session.metadata);
            
            break;

        case 'customer.subscription.created':
            const subscription = event.data.object;
            console.log('Subscription created:', subscription.id);
            
            // TODO: Activate premium for user
            // await activatePremium(subscription.metadata.userId);
            
            break;

        case 'customer.subscription.deleted':
            const deletedSub = event.data.object;
            console.log('Subscription cancelled:', deletedSub.id);
            
            // TODO: Deactivate premium for user
            // await deactivatePremium(deletedSub.metadata.userId);
            
            break;

        case 'payment_intent.payment_failed':
            const failedPayment = event.data.object;
            console.log('Payment failed:', failedPayment.id);
            
            // TODO: Notify user of failed payment
            
            break;

        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    // Return a response to acknowledge receipt of the event
    res.json({ received: true });
});

// ===== ADMIN ENDPOINTS (OPTIONAL) =====

// Refund a payment
app.post('/admin/refund', async (req, res) => {
    try {
        const { paymentIntentId, amount } = req.body;

        const refund = await stripe.refunds.create({
            payment_intent: paymentIntentId,
            amount: amount // Optional: partial refund
        });

        res.json({ success: true, refund: refund });

    } catch (error) {
        console.error('Refund error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get customer's purchase history
app.get('/admin/purchases/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        // Find customer by metadata
        const customers = await stripe.customers.search({
            query: `metadata['userId']:'${userId}'`,
            limit: 1
        });

        if (customers.data.length === 0) {
            return res.json({ purchases: [] });
        }

        const customer = customers.data[0];

        // Get payment intents
        const payments = await stripe.paymentIntents.list({
            customer: customer.id,
            limit: 100
        });

        res.json({ 
            purchases: payments.data.map(p => ({
                id: p.id,
                amount: p.amount / 100,
                status: p.status,
                created: new Date(p.created * 1000)
            }))
        });

    } catch (error) {
        console.error('Purchase history error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Portfolio Poker payment server running on port ${PORT}`);
    console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
});

// Export for serverless platforms (Vercel, Netlify)
module.exports = app;
