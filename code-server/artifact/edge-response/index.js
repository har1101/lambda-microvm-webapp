function hasMvmSessionCookie(headers) {
  const cookies = headers.cookie || [];
  return cookies.some((h) => /(?:^|;\s*)mvm-session=/.test(h.value));
}

function isHtmlNavigation(headers) {
  const accept = headers.accept || [];
  return accept.some((h) => h.value.includes('text/html'));
}

exports.handler = async (event) => {
  const { request, response } = event.Records[0].cf;
  const status = parseInt(response.status, 10);

  const recoverable = status === 502 || status === 504;

  if (recoverable && hasMvmSessionCookie(request.headers) && isHtmlNavigation(request.headers)) {
    return {
      status: '302',
      statusDescription: 'Found',
      headers: {
        // Keep the association cookie. A suspended or still-resuming MicroVM
        // can temporarily return 502/504 even though its workspace is intact.
        location: [{ key: 'Location', value: '/session/select' }],
        'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      },
    };
  }

  return response;
};
