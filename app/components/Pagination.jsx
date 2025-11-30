export default function Pagination({
    page,
    totalPages,
    pageSize,
    totalItems,
    onChange,
}) {
    if (totalPages <= 1) return null;

    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, totalItems);

    const goToPage = (p) => {
        if (p < 1 || p > totalPages) return;
        onChange(p);
    };

    return (
        <div className="flex items-center justify-between border-t border-white/10 px-4 py-3 sm:px-6">

            {/* MOBILE (Prev/Next only) */}
            <div className="flex flex-1 justify-between sm:hidden">
                <button
                    onClick={() => goToPage(page - 1)}
                    disabled={page === 1}
                    className="relative inline-flex items-center rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-white/10 disabled:opacity-40"
                >
                    <s-icon type="arrow-left" />
                </button>
                <button
                    onClick={() => goToPage(page + 1)}
                    disabled={page === totalPages}
                    className="relative ml-3 inline-flex items-center rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-white/10 disabled:opacity-40"
                >
                    <s-icon type="arrow-right" />
                </button>
            </div>

            {/* DESKTOP */}
            <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
                {/* Showing X to Y of Z */}
                <p className="text-sm text-gray-700">
                    Mostrando <span className="font-medium">{start}</span>
                    {" a "}
                    <span className="font-medium">{end}</span>{" "}
                    {" de "}
                    <span className="font-medium">{totalItems}</span>{" "}
                    resultados
                </p>

                {/* Pagination nav */}
                <nav aria-label="Pagination" className="flex items-center gap-2">

                    {/* Previous Arrow */}
                    <button
                        onClick={() => goToPage(page - 1)}
                        disabled={page === 1}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"

                    >
                        <span className="sr-only">Anterior</span>
                        <s-icon type="arrow-left" />
                    </button>

                    {/* Page numbers */}
                    {Array.from({ length: totalPages }).map((_, i) => {
                        const p = i + 1;

                        // Mostrar siempre 1, la actual, la anterior, la siguiente y la última
                        const show =
                            p === 1 ||
                            p === totalPages ||
                            Math.abs(p - page) <= 1;

                        if (!show) {
                            if (p === 2 || p === totalPages - 1) {
                                return (
                                    <span
                                        key={p}
                                        className="inline-flex items-center justify-center px-2 text-sm text-gray-500"
                                    >
                                        ...
                                    </span>
                                );
                            }
                            return null;
                        }

                        const isActive = p === page;

                        return (
                            <button
                                key={p}
                                onClick={() => goToPage(p)}
                                className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border text-sm font-medium shadow-sm transition-colors focus:outline-none ${isActive
                                    ? "border-blue-600 bg-blue-50 text-blue-600"
                                    : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                                    }`}
                            >
                                {p}
                            </button>
                        );
                    })}

                    {/* Next Arrow */}
                    <button
                        onClick={() => goToPage(page + 1)}
                        disabled={page === totalPages}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
                    >
                        <span className="sr-only">Siguiente</span>
                        <s-icon type="arrow-right" />
                    </button>

                </nav>
            </div>
        </div>
    );
}
