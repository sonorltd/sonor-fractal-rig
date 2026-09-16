#pragma once
/* Optional NDI sender (HAVE_NDI). Safe no-ops when not built in. */
int            ndi_init(const char *name, int w, int h, int fps);  /* 1 = sending */
unsigned char *ndi_buffer(void);      /* RGBA w*h*4 buffer to fill (glReadPixels), then ndi_send() */
void           ndi_send(void);
int            ndi_connections(void); /* receivers currently connected */
int            ndi_available(void);
void           ndi_shutdown(void);
