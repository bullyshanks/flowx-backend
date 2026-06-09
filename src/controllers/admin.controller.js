// ── Admin dashboard analytics ──
const prisma = require('../config/prisma');

exports.dashboard = async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [
      totalCustomers, totalVendors, pendingVendors,
      todayOrders, monthOrders, pendingOrders,
      activeSubscriptions, totalRevenueAgg, monthRevenueAgg,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.user.count({ where: { role: 'VENDOR', vendorStatus: 'APPROVED' } }),
      prisma.user.count({ where: { role: 'VENDOR', vendorStatus: 'PENDING' } }),
      prisma.order.count({ where: { createdAt: { gte: today } } }),
      prisma.order.count({ where: { createdAt: { gte: startOfMonth } } }),
      prisma.order.count({ where: { status: { in: ['PENDING', 'CONFIRMED'] } } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { status: 'DELIVERED' } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { status: 'DELIVERED', createdAt: { gte: startOfMonth } } }),
    ]);

    res.json({
      success: true,
      stats: {
        users: { customers: totalCustomers, vendors: totalVendors, pendingVendors },
        orders: { today: todayOrders, month: monthOrders, pending: pendingOrders },
        subscriptions: { active: activeSubscriptions },
        revenue: {
          total: Number(totalRevenueAgg._sum.total || 0),
          month: Number(monthRevenueAgg._sum.total || 0),
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
