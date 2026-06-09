# FlowX Water Delivery — Backend API

Production-ready Node.js + Express + PostgreSQL backend for the FlowX water delivery platform.

## 🛠 Tech Stack

- **Runtime:** Node.js 20+
- **Framework:** Express.js
- **Database:** PostgreSQL 16
- **ORM:** Prisma
- **Auth:** JWT + Phone OTP
- **SMS:** Pluggable (Jazz/Telenor/any PK gateway)

## 📦 Setup (First Time)

### 1. Install Node.js & PostgreSQL

```bash
# Verify Node version
node --version    # should be 20 or higher

# Verify PostgreSQL
psql --version    # should be 14 or higher
```

### 2. Create the database

```bash
# Login to Postgres
psql -U postgres

# Create the database
CREATE DATABASE flowx_db;
\q
```

### 3. Install dependencies

```bash
npm install
```

### 4. Configure environment

```bash
cp .env.example .env
```

Then open `.env` and update:
- `DATABASE_URL` — your PostgreSQL connection string
- `JWT_SECRET` — generate a 64-char random string
- `SMS_API_KEY` — leave default to use console-log mode for now

### 5. Run migrations & seed

```bash
# Create database tables
npm run prisma:migrate

# Generate Prisma client
npm run prisma:generate

# Seed initial data (zones, products, admin user)
npm run seed
```

### 6. Start the server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

Server runs at: **http://localhost:4000**

Health check: **http://localhost:4000/api/health**

---

## 📡 API Endpoints

### 🔐 Auth — `/api/auth`

| Method | Path | Description |
|---|---|---|
| POST | `/register/customer` | Register customer (name, phone, email, password, zoneId) |
| POST | `/register/vendor` | Register vendor (name, phone, password, cnic, zoneId) |
| POST | `/otp/send` | Send OTP to phone |
| POST | `/otp/verify` | Verify OTP, returns JWT |
| POST | `/login` | Password login (vendors/admin) |
| GET | `/me` | Current user profile (auth required) |

### 🛒 Products — `/api/products`

| Method | Path | Description |
|---|---|---|
| GET | `/` | List active products |
| GET | `/zones` | List all delivery zones |
| GET | `/:id` | Get one product |
| POST | `/` | Create product (admin) |
| PUT | `/:id` | Update product (admin) |
| DELETE | `/:id` | Deactivate product (admin) |

### 📦 Orders — `/api/orders`

| Method | Path | Description |
|---|---|---|
| POST | `/` | Place order (guest or auth) |
| GET | `/track/:orderNumber` | Public order tracking |
| GET | `/my-orders` | Customer's orders |
| GET | `/vendor/queue` | Vendor's available + assigned orders |
| POST | `/:id/accept` | Vendor accepts an order |
| PATCH | `/:id/status` | Vendor/admin updates status |
| GET | `/admin/all` | Admin list all orders |
| POST | `/:id/assign` | Admin manually assigns vendor |

### 🚚 Vendors — `/api/vendors`

| Method | Path | Description |
|---|---|---|
| GET | `/dashboard` | Vendor dashboard stats |
| GET | `/` | Admin: list vendors (filter by status, zone) |
| POST | `/:id/approve` | Admin approves vendor |
| POST | `/:id/reject` | Admin rejects vendor |
| PATCH | `/:id/zone` | Admin changes vendor's zone |

### ♻️ Subscriptions — `/api/subscriptions`

| Method | Path | Description |
|---|---|---|
| POST | `/` | Create subscription |
| GET | `/my` | Customer's subscriptions |
| POST | `/:id/pause` | Pause subscription |
| POST | `/:id/resume` | Resume subscription |
| POST | `/:id/cancel` | Cancel subscription |
| GET | `/admin/all` | Admin list all subscriptions |

### 📊 Admin — `/api/admin`

| Method | Path | Description |
|---|---|---|
| GET | `/dashboard` | Dashboard analytics |
| GET | `/orders/by-status` | Orders grouped by status |
| GET | `/orders/top-zones` | Top zones by order count |

---

## 🧪 Testing with Postman / curl

### Place a guest order:

```bash
curl -X POST http://localhost:4000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "guestName": "Ahmed Khan",
    "guestPhone": "03001234567",
    "deliveryAddress": "House #123, Street 5, North Karachi",
    "zoneId": "<paste-zone-id-from-/api/products/zones>",
    "paymentMethod": "COD",
    "items": [
      { "productId": "<paste-product-id-from-/api/products>", "quantity": 3 }
    ]
  }'
```

### Track an order:

```bash
curl http://localhost:4000/api/orders/track/FLW-2026-12345
```

### Admin login:

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "phone": "03158374442", "password": "ChangeMe123!" }'
```

---

## 🗂 Project Structure

```
flowx-backend/
├── prisma/
│   ├── schema.prisma         ← Database schema (single source of truth)
│   └── seed.js               ← Initial data (zones, products, admin)
├── src/
│   ├── config/
│   │   └── prisma.js         ← Prisma client instance
│   ├── controllers/          ← Business logic
│   │   ├── auth.controller.js
│   │   ├── product.controller.js
│   │   ├── order.controller.js
│   │   ├── vendor.controller.js
│   │   ├── subscription.controller.js
│   │   └── admin.controller.js
│   ├── middleware/
│   │   ├── auth.js           ← JWT verification + role guards
│   │   └── errorHandler.js   ← Global error handler
│   ├── routes/               ← Express routers
│   ├── services/
│   │   └── sms.service.js    ← SMS gateway integration
│   ├── utils/
│   │   ├── jwt.js
│   │   └── generators.js
│   ├── app.js                ← Express app config
│   └── server.js             ← Entry point
├── .env.example
├── .gitignore
└── package.json
```

---

## 🚀 Deployment

When ready, deploy to **Railway** or **Render** in 5 minutes:

1. Push code to GitHub
2. Connect repo on railway.app or render.com
3. Add a PostgreSQL service
4. Set environment variables (copy from `.env`)
5. Deploy. Done.

---

## 🔒 Security Notes

- All passwords are bcrypt-hashed (10 rounds)
- JWT tokens expire after 7 days
- Rate limiting: 200 requests / 15 min globally, 20 / 15 min on auth endpoints
- Helmet sets secure HTTP headers
- CORS restricted to FRONTEND_URL in production
- Role-based access control (CUSTOMER, VENDOR, ADMIN)
- Vendors can only see orders in their zone

---

## 📖 Useful Commands

```bash
npm run dev                # Start with auto-reload
npm run prisma:studio      # Visual DB browser at localhost:5555
npm run prisma:migrate     # Create + apply new migrations
npm run seed               # Reseed initial data
```

---

Built with ❤️ for FlowX — Pure Water · Fast Delivery
