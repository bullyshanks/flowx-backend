// ═══════════════════════════════════════════════════════════
//  Vendor Controller
//  Admin: list/approve/reject vendors. Vendor: dashboard stats
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');
const {
  sendVendorApprovedSms, sendAccountSuspendedSms, sendAccountReactivatedSms, sendAccountRejectedSms,
} = require('../services/sms.service');
const {
  sendVendorApprovedPush, sendAccountSuspendedPush, sendAccountReactivatedPush, sendAccountRejectedPush,
} = require('../services/push.service');
const { tryAssignVendor, unassignVendorOrders } = require('../services/assignment.service');
const { generateReferralCode } = require('../utils/generators');

// ─────────────────────────────────────────────
// GET /vendors/referral — this vendor's referral code and what it has earned
// ─────────────────────────────────────────────
// Vendors registered before the scheme existed have no code, so mint one on
// first read rather than running a backfill migration.
exports.getReferral = async (req, res, next) => {
  try {
    let user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { referralCode: true },
    });

    if (!user.referralCode) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          user = await prisma.user.update({
            where: { id: req.user.id },
            data: { referralCode: generateReferralCode() },
            select: { referralCode: true },
          });
          break;
        } catch (err) {
          if (err.code !== 'P2002') throw err; // code collision — try another
        }
      }
    }

    const [referrals, settings, earnedAgg] = await Promise.all([
      prisma.referral.findMany({
        where: { referrerId: req.user.id, kind: 'VENDOR' },
        orderBy: { createdAt: 'desc' },
        select: {
          status: true, referrerBonus: true, createdAt: true, creditedAt: true,
          // Enough to recognise who they referred, without handing over a
          // phone number they may not have shared with this vendor.
          referee: { select: { name: true, zone: { select: { name: true } } } },
        },
      }),
      prisma.commissionSettings.findFirst(),
      prisma.ledgerEntry.aggregate({
        where: { vendorId: req.user.id, type: 'REFERRAL_BONUS' },
        _sum: { amount: true },
      }),
    ]);

    res.json({
      success: true,
      referralCode: user.referralCode,
      rewardPerVendor: Number(settings?.vendorReferralReward ?? 1000),
      signedUp: referrals.length,
      credited: referrals.filter((r) => r.status === 'CREDITED').length,
      totalEarned: Number(earnedAgg._sum.amount || 0),
      referrals: referrals.map((r) => ({
        name: r.referee.name,
        zone: r.referee.zone?.name || null,
        status: r.status,
        bonus: Number(r.referrerBonus),
        createdAt: r.createdAt,
        creditedAt: r.creditedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: list all vendors (filterable)
// ─────────────────────────────────────────────
exports.listVendors = async (req, res, next) => {
  try {
    const { status, zoneId } = req.query;

    const vendors = await prisma.user.findMany({
      where: {
        role: 'VENDOR',
        ...(status && { vendorStatus: status }),
        ...(zoneId && { zoneId }),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, phone: true, cnic: true, vendorStatus: true, kycStatus: true,
        businessName: true, shopDetails: true, isOpen: true, stockStatus: true,
        approvedAt: true, createdAt: true,
        zone: { select: { id: true, name: true } },
        _count: { select: { assignedOrders: true } },
      },
    });

    res.json({ success: true, vendors });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: approve a vendor
// ─────────────────────────────────────────────
exports.approveVendor = async (req, res, next) => {
  try {
    const existing = await prisma.user.findFirst({ where: { id: req.params.id, role: 'VENDOR' } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }
    if (existing.vendorStatus !== 'PENDING') {
      return res.status(409).json({
        success: false,
        message: `Cannot approve a vendor with status ${existing.vendorStatus}`,
      });
    }

    const vendor = await prisma.user.update({
      where: { id: existing.id },
      data: {
        vendorStatus: 'APPROVED',
        approvedAt: new Date(),
        isVerified: true,
        rejectedReason: null,
      },
    });

    sendVendorApprovedPush(vendor.id);
    sendVendorApprovedSms(vendor.phone);

    res.json({ success: true, message: 'Vendor approved', vendor });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: reject a vendor
// ─────────────────────────────────────────────
exports.rejectVendor = async (req, res, next) => {
  try {
    const existing = await prisma.user.findFirst({ where: { id: req.params.id, role: 'VENDOR' } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }
    if (existing.vendorStatus !== 'PENDING') {
      return res.status(409).json({
        success: false,
        message: `Cannot reject a vendor with status ${existing.vendorStatus}`,
      });
    }

    const { reason } = req.body;
    const vendor = await prisma.user.update({
      where: { id: existing.id },
      data: {
        vendorStatus: 'REJECTED',
        rejectedReason: reason || 'Application rejected',
      },
    });

    sendAccountRejectedPush(vendor.id, reason);
    if (vendor.phone) sendAccountRejectedSms(vendor.phone, reason);

    res.json({ success: true, message: 'Vendor rejected', vendor });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: suspend/reactivate a vendor (toggle between APPROVED and SUSPENDED)
// ─────────────────────────────────────────────
exports.toggleSuspend = async (req, res, next) => {
  try {
    const existing = await prisma.user.findFirst({ where: { id: req.params.id, role: 'VENDOR' } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }
    if (existing.vendorStatus !== 'APPROVED' && existing.vendorStatus !== 'SUSPENDED') {
      return res.status(409).json({
        success: false,
        message: `Cannot suspend a vendor with status ${existing.vendorStatus}`,
      });
    }

    const { reason } = req.body;
    const suspending = existing.vendorStatus === 'APPROVED';
    const vendor = await prisma.user.update({
      where: { id: existing.id },
      data: suspending
        ? { vendorStatus: 'SUSPENDED', rejectedReason: reason || 'Account suspended' }
        : { vendorStatus: 'APPROVED', rejectedReason: null },
    });

    if (suspending) sendAccountSuspendedPush(vendor.id, reason);
    else sendAccountReactivatedPush(vendor.id);

    if (vendor.phone) {
      if (suspending) sendAccountSuspendedSms(vendor.phone, reason);
      else sendAccountReactivatedSms(vendor.phone);
    }

    if (suspending) await unassignVendorOrders(vendor.id);

    res.json({ success: true, message: suspending ? 'Vendor suspended' : 'Vendor reactivated', vendor });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: change vendor zone
// ─────────────────────────────────────────────
exports.changeVendorZone = async (req, res, next) => {
  try {
    const { zoneId } = req.body;
    const vendor = await prisma.user.update({
      where: { id: req.params.id, role: 'VENDOR' },
      data: { zoneId },
      include: { zone: true },
    });
    res.json({ success: true, vendor });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Vendor: update my own storefront (open/closed, in stock/out of stock)
// ─────────────────────────────────────────────
exports.updateStorefront = async (req, res, next) => {
  try {
    const { isOpen, stockStatus } = req.body;
    const data = {};
    if (typeof isOpen === 'boolean') data.isOpen = isOpen;
    if (typeof stockStatus === 'boolean') data.stockStatus = stockStatus;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const vendor = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: { id: true, zoneId: true, isOpen: true, stockStatus: true },
    });

    // Reopening (or restocking) can unblock orders that never got offered to
    // anyone because no vendor was eligible in the zone at the time — those
    // otherwise sit stuck forever, since reassignIfExpired only re-checks
    // offers that were made and expired, not orders that never got one.
    if (vendor.isOpen && vendor.stockStatus) {
      const orphaned = await prisma.order.findMany({
        where: {
          zoneId: vendor.zoneId,
          status: 'PENDING',
          vendorId: null,
          offeredVendorId: null,
        },
        select: { id: true },
      });
      for (const order of orphaned) {
        await tryAssignVendor(order.id);
      }
    }

    res.json({ success: true, vendor });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Vendor: list my product catalog with my own price/stock overrides
// ─────────────────────────────────────────────
exports.listMyProducts = async (req, res, next) => {
  try {
    const [products, overrides] = await Promise.all([
      prisma.product.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
      prisma.vendorProduct.findMany({ where: { vendorId: req.user.id } }),
    ]);

    const products_ = products.map((p) => {
      const override = overrides.find((o) => o.productId === p.id);
      return {
        id: p.id,
        name: p.name,
        unit: p.unit,
        minQuantity: p.minQuantity,
        imageUrl: p.imageUrl,
        catalogPrice: p.price,
        price: override?.price != null ? override.price : p.price,
        hasOverridePrice: override?.price != null,
        inStock: override ? override.inStock : true,
      };
    });

    res.json({ success: true, products: products_ });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Vendor: set my own price and/or stock for one product
// PATCH /me/products/:productId — { price?: number|null, inStock?: boolean }
// price: null resets to the catalog price.
// ─────────────────────────────────────────────
exports.updateMyProduct = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { price, inStock } = req.body;

    const product = await prisma.product.findFirst({ where: { id: productId, isActive: true } });
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const data = {};
    if (price !== undefined) {
      if (price === null) {
        data.price = null;
      } else {
        const value = Number(price);
        if (Number.isNaN(value) || value < 0) {
          return res.status(400).json({ success: false, message: 'price must be >= 0 (or null to use catalog price)' });
        }
        data.price = value;
      }
    }
    if (typeof inStock === 'boolean') data.inStock = inStock;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const updated = await prisma.vendorProduct.upsert({
      where: { vendorId_productId: { vendorId: req.user.id, productId } },
      update: data,
      create: { vendorId: req.user.id, productId, ...data },
    });

    // Coming back in stock (or re-listing at a price) can unblock pending
    // orders that never got offered to anyone in this zone — mirrors the
    // storefront-reopen sweep in updateStorefront above.
    if (updated.inStock) {
      const orphaned = await prisma.order.findMany({
        where: { zoneId: req.user.zoneId, status: 'PENDING', vendorId: null, offeredVendorId: null },
        select: { id: true },
      });
      for (const order of orphaned) {
        await tryAssignVendor(order.id);
      }
    }

    res.json({ success: true, product: updated });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Vendor: dashboard stats
// ─────────────────────────────────────────────
exports.dashboard = async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [todayOrders, pendingOrders, completedOrders, totalAssigned] = await Promise.all([
      prisma.order.count({
        where: { vendorId: req.user.id, createdAt: { gte: today } },
      }),
      prisma.order.count({
        where: { vendorId: req.user.id, status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] } },
      }),
      prisma.order.count({
        where: { vendorId: req.user.id, status: 'DELIVERED' },
      }),
      prisma.order.count({ where: { vendorId: req.user.id } }),
    ]);

    res.json({
      success: true,
      stats: { todayOrders, pendingOrders, completedOrders, totalAssigned },
    });
  } catch (err) {
    next(err);
  }
};
