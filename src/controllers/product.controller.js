// ─── Product CRUD ───
const prisma = require('../config/prisma');

exports.getAll = async (req, res, next) => {
  try {
    const products = await prisma.product.findMany({
      where: { isActive: true },
      orderBy: { price: 'asc' },
    });
    res.json({ success: true, products });
  } catch (err) {
    next(err);
  }
};

exports.getOne = async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
    });
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    res.json({ success: true, product });
  } catch (err) {
    next(err);
  }
};

exports.getZones = async (req, res, next) => {
  try {
    const zones = await prisma.zone.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, city: true },
    });
    res.json({ success: true, zones });
  } catch (err) {
    next(err);
  }
};

// ── Admin only ──
// Whitelisted, validated fields only — never pass req.body straight to
// Prisma here (id/createdAt/updatedAt must never be caller-settable).
function pickAndValidateProductFields(body, { partial }) {
  const data = {};
  const err = (message) => Object.assign(new Error(message), { status: 400 });

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw err('name must be a non-empty string');
    data.name = body.name.trim();
  } else if (!partial) {
    throw err('name is required');
  }

  if (body.slug !== undefined) {
    if (typeof body.slug !== 'string' || !body.slug.trim()) throw err('slug must be a non-empty string');
    data.slug = body.slug.trim();
  } else if (!partial) {
    throw err('slug is required');
  }

  if (body.price !== undefined) {
    const price = Number(body.price);
    if (Number.isNaN(price) || price < 0) throw err('price must be a number >= 0');
    data.price = price;
  } else if (!partial) {
    throw err('price is required');
  }

  if (body.unit !== undefined) {
    if (typeof body.unit !== 'string' || !body.unit.trim()) throw err('unit must be a non-empty string');
    data.unit = body.unit.trim();
  } else if (!partial) {
    throw err('unit is required');
  }

  if (body.description !== undefined) data.description = body.description === null ? null : String(body.description);
  if (body.imageUrl !== undefined) data.imageUrl = body.imageUrl === null ? null : String(body.imageUrl);

  if (body.minQuantity !== undefined) {
    const minQuantity = Number(body.minQuantity);
    if (!Number.isInteger(minQuantity) || minQuantity < 1) throw err('minQuantity must be an integer >= 1');
    data.minQuantity = minQuantity;
  }

  if (body.commissionPct !== undefined) {
    if (body.commissionPct === null) {
      data.commissionPct = null;
    } else {
      const pct = Number(body.commissionPct);
      if (Number.isNaN(pct) || pct < 0 || pct > 100) throw err('commissionPct must be 0-100 (or null for default)');
      data.commissionPct = pct;
    }
  }

  if (body.riderEarningPerUnit !== undefined) {
    const rate = Number(body.riderEarningPerUnit);
    if (Number.isNaN(rate) || rate < 0) throw err('riderEarningPerUnit must be >= 0');
    data.riderEarningPerUnit = rate;
  }

  if (body.hasRiderDelivery !== undefined) {
    if (typeof body.hasRiderDelivery !== 'boolean') throw err('hasRiderDelivery must be a boolean');
    data.hasRiderDelivery = body.hasRiderDelivery;
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') throw err('isActive must be a boolean');
    data.isActive = body.isActive;
  }

  return data;
}

exports.create = async (req, res, next) => {
  try {
    const data = pickAndValidateProductFields(req.body, { partial: false });
    const product = await prisma.product.create({ data });
    res.status(201).json({ success: true, product });
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const data = pickAndValidateProductFields(req.body, { partial: true });
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ success: true, product });
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    await prisma.product.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.json({ success: true, message: 'Product deactivated' });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Zones — admin CRUD. Zones are referenced by User.zoneId, Order.zoneId,
// and Subscription.zoneId, so there's no delete: deactivating hides a zone
// from the public /products/zones list (signup/checkout dropdowns) without
// touching any existing vendor, rider, order, or subscription that
// references it.
// ─────────────────────────────────────────────
exports.adminListZones = async (req, res, next) => {
  try {
    const zones = await prisma.zone.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { users: true, orders: true, subscriptions: true } },
      },
    });
    res.json({ success: true, zones });
  } catch (err) {
    next(err);
  }
};

function pickAndValidateZoneFields(body, { partial }) {
  const data = {};
  const err = (message) => Object.assign(new Error(message), { status: 400 });

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw err('name must be a non-empty string');
    data.name = body.name.trim();
  } else if (!partial) {
    throw err('name is required');
  }

  if (body.city !== undefined) {
    if (typeof body.city !== 'string' || !body.city.trim()) throw err('city must be a non-empty string');
    data.city = body.city.trim();
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') throw err('isActive must be a boolean');
    data.isActive = body.isActive;
  }

  return data;
}

exports.createZone = async (req, res, next) => {
  try {
    const data = pickAndValidateZoneFields(req.body, { partial: false });
    const zone = await prisma.zone.create({ data });
    res.status(201).json({ success: true, zone });
  } catch (err) {
    next(err);
  }
};

exports.updateZone = async (req, res, next) => {
  try {
    const data = pickAndValidateZoneFields(req.body, { partial: true });
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }
    const zone = await prisma.zone.update({ where: { id: req.params.id }, data });
    res.json({ success: true, zone });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ success: false, message: 'Zone not found' });
    next(err);
  }
};
