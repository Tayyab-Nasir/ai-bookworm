# Test-only engine: official databases plus one harmless, exact-byte fixture.
FROM clamav/clamav:stable
ENV TZ=UTC
COPY bookworm.hsb /var/lib/clamav/bookworm.hsb
COPY clamd.conf /etc/clamav/bookworm.conf
COPY freshclam.conf /etc/clamav/bookworm-freshclam.conf
USER clamav
# Refresh preloaded signatures without relaxing the application's age gate.
# Network access is needed at build time, not during acceptance runtime.
RUN freshclam --config-file=/etc/clamav/bookworm-freshclam.conf
ENTRYPOINT ["clamd", "--foreground=true", "--config-file=/etc/clamav/bookworm.conf"]
