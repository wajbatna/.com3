# Wajbatna — Secure Cloud Functions package

This package moves security-sensitive operations from the browser to Firebase Cloud Functions:

- `createOrder`: validates the authenticated customer, reads current meal prices from Firestore, calculates the total server-side, creates the order and awards order/referral points.
- `redeemReward`: validates the current reward price and atomically creates the redemption and points debit.
- `submitOrderReview`: validates ownership, prevents duplicate reviews, and awards review points once.
- Membership is generated/updated server-side after a successful order.

## 1. Install

Requirements:
- Node.js 20
- Firebase CLI
- A Firebase project with Firestore and Authentication enabled

From the project root:

```bash
cd functions
npm install
cd ..
```

## 2. Select the Firebase project

```bash
firebase login
firebase use wajbatna-c83ee
```

If the project alias is different, replace it with your Firebase project ID.

## 3. Deploy rules and functions

```bash
firebase deploy --only firestore:rules,functions
```

Then deploy the website:

```bash
firebase deploy --only hosting
```

## 4. Important security change

Do NOT restore direct browser writes to:

- `orders`
- `pointsLog`
- `members`
- `redemptions`

The supplied `public/app.js` calls the Cloud Functions instead.

## 5. Existing Firebase configuration

`public/firebase.js` contains the public Firebase Web configuration. A Firebase Web API key is not a server secret. Never add a Firebase Admin service-account private key to `public/` or any browser JavaScript.

## 6. Before production

Test these flows in a test account:

1. Create an order with one meal.
2. Create an order with multiple meals.
3. Try changing the price in browser DevTools — the server should ignore it and use the Firestore meal price.
4. Redeem a reward twice concurrently — only valid balance should be accepted.
5. Review the same order twice — the second review should fail.
6. Create enough order days to reach the 3-day membership threshold.
7. Check that a normal customer cannot create `pointsLog`, `members`, or `redemptions` directly.

## 7. Existing admin panel

Admin writes to meals/config/rewards continue to use Firestore directly and are protected by the `admins/{uid}` rule.
