// ─── Product CRUD ───
const prisma = require('../config/prisma');
const { serviceableZoneIds } = require('../services/assignment.service');

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

// Zones are still all returned, each flagged with whether we can actually
// deliver there. Hiding the unserved ones would leave a customer in DHA
// wondering why their area is missing from a site that lists it everywhere
// else; saying "not available yet" is the honest answer, and it doubles as a
// signal of where FlowX needs to recruit vendors.
//
// The flag is a convenience for the UI, not the guard — order and subscription
// creation check serviceability themselves, since a client can send any zoneId
// it likes.
exports.getZones = async (req, res, next) => {
  try {
    const [zones, serviceable] = await Promise.all([
      prisma.zone.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, city: true },
      }),
      serviceableZoneIds(),
    ]);
    res.json({
      success: true,
      zones: zones.map((z) => ({ ...z, isServiceable: serviceable.has(z.id) })),
    });
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
// Admin zone list, doubling as the vendor-recruitment worklist.
//
// "No orders" in a zone is ambiguous on its own — it could mean no demand, or
// demand we turned away for having no vendor. demandLast30d is what separates
// them, and it's the number that says which uncovered zone to recruit first.
exports.adminListZones = async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [zones, vendorCounts, riderCounts, demandCounts] = await Promise.all([
      prisma.zone.findMany({
        orderBy: { name: 'asc' },
        include: { _count: { select: { users: true, orders: true, subscriptions: true } } },
      }),
      // Approved, KYC'd and unfrozen — the same definition serviceability uses,
      // so this column can never disagree with whether checkout is open.
      prisma.user.groupBy({
        by: ['zoneId'],
        where: {
          role: 'VENDOR', vendorStatus: 'APPROVED', kycStatus: 'APPROVED',
          isFrozen: false, zoneId: { not: null },
        },
        _count: { _all: true },
      }),
      prisma.user.groupBy({
        by: ['zoneId'],
        where: {
          role: 'RIDER', vendorStatus: 'APPROVED', kycStatus: 'APPROVED',
          isFrozen: false, zoneId: { not: null },
        },
        _count: { _all: true },
      }),
      prisma.zoneDemand.groupBy({
        by: ['zoneId'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    const countBy = (rows) => new Map(rows.map((r) => [r.zoneId, r._count._all]));
    const vendors = countBy(vendorCounts);
    const riders = countBy(riderCounts);
    const demand = countBy(demandCounts);

    res.json({
      success: true,
      zones: zones.map((z) => ({
        ...z,
        activeVendors: vendors.get(z.id) || 0,
        activeRiders: riders.get(z.id) || 0,
        isServiceable: (vendors.get(z.id) || 0) > 0,
        demandLast30d: demand.get(z.id) || 0,
      })),
    });
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
