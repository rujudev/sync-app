export async function loader({ request }) {
    const url = new URL(request.url);
    const imageUrl = url.searchParams.get('url');

    if (!imageUrl) {
        return new Response('Missing url parameter', { status: 400 });
    }

    try {
        const response = await fetch(imageUrl);

        if (!response.ok) {
            return new Response('Image not found', { status: 404 });
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64 = buffer.toString('base64');
        const contentType = response.headers.get('content-type') || 'image/jpeg';

        return Response.json({
            success: true,
            dataUrl: `data:${contentType};base64,${base64}`
        });
    } catch (error) {
        console.error('Error proxying image:', error);
        return Response.json({
            success: false,
            error: error.message
        }, { status: 500 });
    }
}