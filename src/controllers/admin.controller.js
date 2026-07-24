// ── Admin dashboard analytics ──
const prisma = require('../config/prisma');

exports.dashboard = async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [
      totalCustomers, totalVendors, pendingVendors, totalRiders, pendingRiders,
      todayOrders, monthOrders, pendingOrders,
      activeSubscriptions, totalRevenueAgg, monthRevenueAgg,
      codCollectedAgg, onlineReceivedAgg, codLiabilityAgg, commissionAgg, frozenVendors, frozenRiders,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.user.count({ where: { role: 'VENDOR', vendorStatus: 'APPROVED' } }),
      prisma.user.count({ where: { role: 'VENDOR', vendorStatus: 'PENDING' } }),
      prisma.user.count({ where: { role: 'RIDER', vendorStatus: 'APPROVED' } }),
      prisma.user.count({ where: { role: 'RIDER', vendorStatus: 'PENDING' } }),
      prisma.order.count({ where: { createdAt: { gte: today } } }),
      prisma.order.count({ where: { createdAt: { gte: startOfMonth } } }),
      prisma.order.count({ where: { status: { in: ['PENDING', 'CONFIRMED'] } } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { status: 'DELIVERED' } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { status: 'DELIVERED', createdAt: { gte: startOfMonth } } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { status: 'DELIVERED', paymentMethod: 'COD' } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { status: 'DELIVERED', paymentMethod: { not: 'COD' } } }),
      prisma.user.aggregate({ _sum: { codLiability: true }, where: { role: 'VENDOR' } }),
      prisma.ledgerEntry.aggregate({ _sum: { amount: true }, where: { type: 'COMMISSION_DEDUCTED' } }),
      prisma.user.count({ where: { role: 'VENDOR', isFrozen: true } }),
      prisma.user.count({ where: { role: 'RIDER', isFrozen: true } }),
    ]);

    res.json({
      success: true,
      stats: {
        users: {
          customers: totalCustomers,
          vendors: totalVendors, pendingVendors,
          riders: totalRiders, pendingRiders,
        },
        orders: { today: todayOrders, month: monthOrders, pending: pendingOrders },
        subscriptions: { active: activeSubscriptions },
        revenue: {
          total: Number(totalRevenueAgg._sum.total || 0),
          month: Number(monthRevenueAgg._sum.total || 0),
        },
        finance: {
          codCollected: Number(codCollectedAgg._sum.total || 0),
          onlineReceived: Number(onlineReceivedAgg._sum.total || 0),
          outstandingCodLiability: Number(codLiabilityAgg._sum.codLiability || 0),
          commissionRevenue: -Number(commissionAgg._sum.amount || 0),
          frozenVendors,
          frozenRiders,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// Order count grouped by status
exports.ordersByStatus = async (req, res, next) => {
  try {
    const data = await prisma.order.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// Top zones by order volume
exports.topZones = async (req, res, next) => {
  try {
    const data = await prisma.order.groupBy({
      by: ['zoneId'],
      _count: { _all: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    });

    const zoneIds = data.map((d) => d.zoneId);
    const zones = await prisma.zone.findMany({ where: { id: { in: zoneIds } } });

    const result = data.map((d) => ({
      zone: zones.find((z) => z.id === d.zoneId)?.name || 'Unknown',
      orderCount: d._count._all,
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};
