//go:build linux && cgo

#define _GNU_SOURCE
#include "capture.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/mman.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include <gbm.h>
#include <xf86drm.h>
#include <drm_fourcc.h>
#include <wayland-client.h>

#include <gst/gst.h>
#include <gst/allocators/gstdmabuf.h>
#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/video/video.h>

#include "proto-ext-foreign-toplevel-list-v1.h"
#include "proto-ext-image-capture-source-v1.h"
#include "proto-ext-image-copy-capture-v1.h"
#include "proto-linux-dmabuf-v1.h"

#define POOL_SIZE 4
#define MAX_OUTPUTS 16
#define MAX_TOPLEVELS 256
#define MAX_FORMATS 64
#define MAX_PLANES 4

/* GstVideoEncoder offsets PTS by 1000h, so the capture time rides along as a reference timestamp. */
static GstCaps *present_caps;

struct output {
	struct wl_output *wl;
	char name[64];
	int width, height;
};

struct toplevel {
	struct oc_capture *c;
	struct ext_foreign_toplevel_handle_v1 *h;
	char id[64];
	int closed;
};

struct slot {
	struct oc_capture *c;
	struct gbm_bo *bo;
	struct wl_buffer *wl;
	int nplanes;
	int fds[MAX_PLANES];
	gsize offsets[MAX_PLANES];
	gint strides[MAX_PLANES];
	GstMemory *mem[MAX_PLANES];
	int gst_refs; /* GstBuffers alive that reference this slot; guarded by c->mu */
};

struct wl_format {
	uint32_t fourcc;
	uint64_t *mods;
	size_t nmods;
};

struct cursor {
	struct ext_image_copy_capture_cursor_session_v1 *cs;
	struct ext_image_copy_capture_session_v1 *session;
	struct ext_image_copy_capture_frame_v1 *frame;
	int width, height;
	int has_argb, session_done, broken;
	struct wl_buffer *buf;
	uint8_t *data;
	int buf_w, buf_h;
	int pending_hot_x, pending_hot_y;

	/* Published to oc_capture_cursor_wait; guarded by c->cursor_mu. */
	uint64_t img_gen, pos_gen;
	int inside, x, y, hot_x, hot_y, img_w, img_h;
	uint8_t *img; /* RGBA, straight alpha */
};

struct oc_capture {
	struct wl_display *dpy;
	struct wl_registry *reg;
	struct output outputs[MAX_OUTPUTS];
	int noutputs;
	struct ext_output_image_capture_source_manager_v1 *srcmgr;
	/* Window capture: bound only when cfg->window is set. */
	int want_toplevels;
	struct ext_foreign_toplevel_list_v1 *toplevel_list;
	struct ext_foreign_toplevel_image_capture_source_manager_v1 *toplevel_srcmgr;
	struct toplevel toplevels[MAX_TOPLEVELS];
	int ntoplevels;
	struct toplevel *window;
	struct ext_image_copy_capture_manager_v1 *capmgr;
	struct zwp_linux_dmabuf_v1 *dmabuf;
	struct wl_shm *shm;
	struct wl_seat *seat;
	struct wl_pointer *pointer;

	struct output *output;
	struct ext_image_capture_source_v1 *source;
	struct ext_image_copy_capture_session_v1 *session;
	struct ext_image_copy_capture_frame_v1 *frame;
	struct slot *frame_slot;
	int64_t frame_present_us;

	int width, height;
	dev_t dev;
	int have_dev;
	struct wl_format formats[MAX_FORMATS];
	int nformats;
	int session_done;
	int session_stopped;
	int buffer_failed;

	int drm_fd;
	struct gbm_device *gbm;
	uint32_t fourcc;
	uint64_t modifier;
	struct slot slots[POOL_SIZE];

	GstElement *pipeline, *appsrc, *enc, *appsink;
	GstAllocator *dmabuf_alloc;
	GstBuffer *last;
	int64_t last_pts_us;
	int64_t frame_interval_us;
	int64_t next_frame_us;

	struct cursor cursor;
	pthread_mutex_t cursor_mu;
	pthread_cond_t cursor_cond;

	pthread_mutex_t mu;
	pthread_t thread;
	int thread_started;
	int wake_fd;
	atomic_int closing;
	atomic_int want_keyframe;
	atomic_int new_bitrate;
	atomic_int failed;
	char err[256];
};

static int trace_enabled(void) {
	static int v = -1;
	if (v < 0) v = getenv("EVERYWHERE_DESKTOP_TRACE") != NULL;
	return v;
}

static int64_t now_us(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

static void set_err(char *buf, size_t len, const char *fmt, ...) {
	if (!buf || !len) return;
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(buf, len, fmt, ap);
	va_end(ap);
}

static void fail(struct oc_capture *c, const char *fmt, ...) {
	if (atomic_load(&c->failed)) return;
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(c->err, sizeof c->err, fmt, ap);
	va_end(ap);
	atomic_store(&c->failed, 1);
}

static void wake(struct oc_capture *c) {
	uint64_t one = 1;
	if (write(c->wake_fd, &one, sizeof one) < 0) { /* eventfd saturation is harmless */ }
}

/* ---- wl_output ---- */

static void output_geometry(void *d, struct wl_output *o, int32_t x, int32_t y, int32_t pw, int32_t ph,
	int32_t sp, const char *make, const char *model, int32_t transform) {}
static void output_mode(void *d, struct wl_output *o, uint32_t flags, int32_t w, int32_t h, int32_t refresh) {
	struct output *out = d;
	if (flags & WL_OUTPUT_MODE_CURRENT) { out->width = w; out->height = h; }
}
static void output_done(void *d, struct wl_output *o) {}
static void output_scale(void *d, struct wl_output *o, int32_t f) {}
static void output_name(void *d, struct wl_output *o, const char *name) {
	struct output *out = d;
	snprintf(out->name, sizeof out->name, "%s", name);
}
static void output_description(void *d, struct wl_output *o, const char *desc) {}

static const struct wl_output_listener output_listener = {
	.geometry = output_geometry,
	.mode = output_mode,
	.done = output_done,
	.scale = output_scale,
	.name = output_name,
	.description = output_description,
};

/* ---- foreign toplevels (window capture) ---- */

static void toplevel_closed(void *d, struct ext_foreign_toplevel_handle_v1 *h) {
	struct toplevel *t = d;
	t->closed = 1;
	if (t->c->window == t) fail(t->c, "window closed");
}
static void toplevel_done(void *d, struct ext_foreign_toplevel_handle_v1 *h) {}
static void toplevel_title(void *d, struct ext_foreign_toplevel_handle_v1 *h, const char *title) {}
static void toplevel_app_id(void *d, struct ext_foreign_toplevel_handle_v1 *h, const char *app_id) {}
static void toplevel_identifier(void *d, struct ext_foreign_toplevel_handle_v1 *h, const char *id) {
	struct toplevel *t = d;
	snprintf(t->id, sizeof t->id, "%s", id);
}
static const struct ext_foreign_toplevel_handle_v1_listener toplevel_listener = {
	.closed = toplevel_closed,
	.done = toplevel_done,
	.title = toplevel_title,
	.app_id = toplevel_app_id,
	.identifier = toplevel_identifier,
};

static void toplevel_list_toplevel(void *d, struct ext_foreign_toplevel_list_v1 *l, struct ext_foreign_toplevel_handle_v1 *h) {
	struct oc_capture *c = d;
	if (c->ntoplevels >= MAX_TOPLEVELS) {
		ext_foreign_toplevel_handle_v1_destroy(h);
		return;
	}
	struct toplevel *t = &c->toplevels[c->ntoplevels++];
	t->c = c;
	t->h = h;
	ext_foreign_toplevel_handle_v1_add_listener(h, &toplevel_listener, t);
}
static void toplevel_list_finished(void *d, struct ext_foreign_toplevel_list_v1 *l) {}
static const struct ext_foreign_toplevel_list_v1_listener toplevel_list_listener = {
	.toplevel = toplevel_list_toplevel,
	.finished = toplevel_list_finished,
};

/* ---- registry ---- */

static void registry_global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
	struct oc_capture *c = data;
	if (strcmp(iface, wl_output_interface.name) == 0 && c->noutputs < MAX_OUTPUTS && version >= 4) {
		struct output *out = &c->outputs[c->noutputs++];
		out->wl = wl_registry_bind(reg, name, &wl_output_interface, 4);
		wl_output_add_listener(out->wl, &output_listener, out);
	} else if (strcmp(iface, ext_output_image_capture_source_manager_v1_interface.name) == 0) {
		c->srcmgr = wl_registry_bind(reg, name, &ext_output_image_capture_source_manager_v1_interface, 1);
	} else if (c->want_toplevels && strcmp(iface, ext_foreign_toplevel_list_v1_interface.name) == 0) {
		c->toplevel_list = wl_registry_bind(reg, name, &ext_foreign_toplevel_list_v1_interface, 1);
		ext_foreign_toplevel_list_v1_add_listener(c->toplevel_list, &toplevel_list_listener, c);
	} else if (c->want_toplevels && strcmp(iface, ext_foreign_toplevel_image_capture_source_manager_v1_interface.name) == 0) {
		c->toplevel_srcmgr = wl_registry_bind(reg, name, &ext_foreign_toplevel_image_capture_source_manager_v1_interface, 1);
	} else if (strcmp(iface, ext_image_copy_capture_manager_v1_interface.name) == 0) {
		c->capmgr = wl_registry_bind(reg, name, &ext_image_copy_capture_manager_v1_interface, 1);
	} else if (strcmp(iface, wl_shm_interface.name) == 0) {
		c->shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
	} else if (strcmp(iface, wl_seat_interface.name) == 0 && !c->seat) {
		c->seat = wl_registry_bind(reg, name, &wl_seat_interface, 1);
	} else if (strcmp(iface, zwp_linux_dmabuf_v1_interface.name) == 0 && version >= 3) {
		c->dmabuf = wl_registry_bind(reg, name, &zwp_linux_dmabuf_v1_interface, 3);
	}
}
static void registry_remove(void *data, struct wl_registry *reg, uint32_t name) {}
static const struct wl_registry_listener registry_listener = { registry_global, registry_remove };

static int connect_wayland(struct oc_capture *c, char *err, size_t errlen) {
	c->dpy = wl_display_connect(NULL);
	if (!c->dpy) { set_err(err, errlen, "cannot connect to Wayland display (is WAYLAND_DISPLAY set?)"); return -1; }
	c->reg = wl_display_get_registry(c->dpy);
	wl_registry_add_listener(c->reg, &registry_listener, c);
	wl_display_roundtrip(c->dpy);
	wl_display_roundtrip(c->dpy);
	/* Toplevels are announced after the list is bound; their identifiers follow. */
	if (c->toplevel_list) wl_display_roundtrip(c->dpy);
	return 0;
}

/* ---- session ---- */

static void session_buffer_size(void *d, struct ext_image_copy_capture_session_v1 *s, uint32_t w, uint32_t h) {
	struct oc_capture *c = d;
	/* The session restarts the worker at the new size; windows resize often. */
	if (c->session_done && ((int)w != c->width || (int)h != c->height))
		fail(c, "capture size changed (%ux%u -> %ux%u)", c->width, c->height, w, h);
	c->width = w; c->height = h;
}
static void session_shm_format(void *d, struct ext_image_copy_capture_session_v1 *s, uint32_t f) {}
static void session_dmabuf_device(void *d, struct ext_image_copy_capture_session_v1 *s, struct wl_array *dev) {
	struct oc_capture *c = d;
	if (dev->size == sizeof(dev_t)) { memcpy(&c->dev, dev->data, sizeof(dev_t)); c->have_dev = 1; }
}
static void session_dmabuf_format(void *d, struct ext_image_copy_capture_session_v1 *s, uint32_t fourcc, struct wl_array *mods) {
	struct oc_capture *c = d;
	if (c->session_done || c->nformats >= MAX_FORMATS) return;
	struct wl_format *f = &c->formats[c->nformats++];
	f->fourcc = fourcc;
	f->nmods = mods->size / sizeof(uint64_t);
	f->mods = malloc(mods->size ? mods->size : 1);
	memcpy(f->mods, mods->data, mods->size);
}
static void session_done(void *d, struct ext_image_copy_capture_session_v1 *s) {
	((struct oc_capture *)d)->session_done = 1;
}
static void session_stopped(void *d, struct ext_image_copy_capture_session_v1 *s) {
	struct oc_capture *c = d;
	c->session_stopped = 1;
	fail(c, "capture session stopped by compositor");
}
static const struct ext_image_copy_capture_session_v1_listener session_listener = {
	.buffer_size = session_buffer_size,
	.shm_format = session_shm_format,
	.dmabuf_device = session_dmabuf_device,
	.dmabuf_format = session_dmabuf_format,
	.done = session_done,
	.stopped = session_stopped,
};

/* ---- format negotiation ---- */

/* drm formats vapostproc can import, from its caps once it has probed the driver. */
static int va_import_formats(uint32_t *fourccs, uint64_t *mods, int max) {
	GstElement *pp = gst_element_factory_make("vapostproc", NULL);
	if (!pp) return 0;
	int n = 0;
	if (gst_element_set_state(pp, GST_STATE_READY) != GST_STATE_CHANGE_FAILURE) {
		GstPad *pad = gst_element_get_static_pad(pp, "sink");
		GstCaps *caps = gst_pad_query_caps(pad, NULL);
		for (guint i = 0; caps && i < gst_caps_get_size(caps); i++) {
			GstCapsFeatures *feat = gst_caps_get_features(caps, i);
			if (!feat || !gst_caps_features_contains(feat, GST_CAPS_FEATURE_MEMORY_DMABUF)) continue;
			const GValue *v = gst_structure_get_value(gst_caps_get_structure(caps, i), "drm-format");
			if (!v) continue;
			guint cnt = GST_VALUE_HOLDS_LIST(v) ? gst_value_list_get_size(v) : 1;
			for (guint j = 0; j < cnt && n < max; j++) {
				const GValue *e = GST_VALUE_HOLDS_LIST(v) ? gst_value_list_get_value(v, j) : v;
				if (!G_VALUE_HOLDS_STRING(e)) continue;
				uint64_t mod = 0;
				uint32_t fcc = gst_video_dma_drm_fourcc_from_string(g_value_get_string(e), &mod);
				if (fcc == DRM_FORMAT_INVALID) continue;
				fourccs[n] = fcc;
				mods[n] = mod;
				n++;
			}
		}
		if (caps) gst_caps_unref(caps);
		gst_object_unref(pad);
	}
	gst_element_set_state(pp, GST_STATE_NULL);
	gst_object_unref(pp);
	return n;
}

static int choose_format(struct oc_capture *c, uint64_t *mods, size_t *nmods, char *err, size_t errlen) {
	static const uint32_t prefs[] = { DRM_FORMAT_XRGB8888, DRM_FORMAT_ARGB8888, DRM_FORMAT_XBGR8888, DRM_FORMAT_ABGR8888 };
	uint32_t va_fcc[128];
	uint64_t va_mod[128];
	int nva = va_import_formats(va_fcc, va_mod, 128);
	if (nva == 0) { set_err(err, errlen, "vapostproc reports no importable dmabuf formats"); return -1; }

	for (size_t p = 0; p < sizeof prefs / sizeof *prefs; p++) {
		for (int i = 0; i < c->nformats; i++) {
			struct wl_format *f = &c->formats[i];
			if (f->fourcc != prefs[p]) continue;
			*nmods = 0;
			for (size_t m = 0; m < f->nmods; m++)
				for (int v = 0; v < nva; v++)
					if (va_fcc[v] == f->fourcc && va_mod[v] == f->mods[m] && *nmods < 32)
						mods[(*nmods)++] = f->mods[m];
			if (*nmods) { c->fourcc = f->fourcc; return 0; }
		}
	}
	char buf[512] = "";
	for (int i = 0; i < c->nformats && strlen(buf) < 400; i++) {
		char tmp[64];
		snprintf(tmp, sizeof tmp, " %.4s(%zu mods)", (char *)&c->formats[i].fourcc, c->formats[i].nmods);
		strcat(buf, tmp);
	}
	set_err(err, errlen, "no dmabuf format shared by Hyprland and VA-API; compositor offers:%s", buf);
	return -1;
}

static int open_render_node(struct oc_capture *c, char *err, size_t errlen) {
	const char *path = "/dev/dri/renderD128";
	drmDevicePtr dev = NULL;
	if (c->have_dev && drmGetDeviceFromDevId(c->dev, 0, &dev) == 0) {
		if (dev->available_nodes & (1 << DRM_NODE_RENDER)) path = dev->nodes[DRM_NODE_RENDER];
	}
	c->drm_fd = open(path, O_RDWR | O_CLOEXEC);
	if (dev) drmFreeDevice(&dev);
	if (c->drm_fd < 0) { set_err(err, errlen, "open render node: %s", strerror(errno)); return -1; }
	c->gbm = gbm_create_device(c->drm_fd);
	if (!c->gbm) { set_err(err, errlen, "gbm_create_device failed"); return -1; }
	return 0;
}

/* ---- buffer pool ---- */

static void dmabuf_created(void *d, struct zwp_linux_buffer_params_v1 *p, struct wl_buffer *b) {}
static void dmabuf_failed(void *d, struct zwp_linux_buffer_params_v1 *p) { *(int *)d = 1; }
static const struct zwp_linux_buffer_params_v1_listener params_listener = { dmabuf_created, dmabuf_failed };

static int alloc_slots(struct oc_capture *c, uint64_t *mods, size_t nmods, char *err, size_t errlen) {
	for (int i = 0; i < POOL_SIZE; i++) {
		struct slot *s = &c->slots[i];
		s->c = c;
		for (int p = 0; p < MAX_PLANES; p++) s->fds[p] = -1;
		s->bo = gbm_bo_create_with_modifiers2(c->gbm, c->width, c->height, c->fourcc, mods, nmods, GBM_BO_USE_RENDERING);
		if (!s->bo) { set_err(err, errlen, "gbm_bo_create_with_modifiers2: %s", strerror(errno)); return -1; }
		c->modifier = gbm_bo_get_modifier(s->bo);
		s->nplanes = gbm_bo_get_plane_count(s->bo);
		if (s->nplanes > MAX_PLANES) { set_err(err, errlen, "too many planes (%d)", s->nplanes); return -1; }

		int failed = 0;
		struct zwp_linux_buffer_params_v1 *params = zwp_linux_dmabuf_v1_create_params(c->dmabuf);
		zwp_linux_buffer_params_v1_add_listener(params, &params_listener, &failed);
		for (int p = 0; p < s->nplanes; p++) {
			s->fds[p] = gbm_bo_get_fd_for_plane(s->bo, p);
			s->offsets[p] = gbm_bo_get_offset(s->bo, p);
			s->strides[p] = gbm_bo_get_stride_for_plane(s->bo, p);
			if (s->fds[p] < 0) { set_err(err, errlen, "gbm_bo_get_fd_for_plane failed"); return -1; }
			zwp_linux_buffer_params_v1_add(params, s->fds[p], p, s->offsets[p], s->strides[p],
				c->modifier >> 32, c->modifier & 0xffffffff);
			off_t size = lseek(s->fds[p], 0, SEEK_END);
			s->mem[p] = gst_dmabuf_allocator_alloc_with_flags(c->dmabuf_alloc, s->fds[p], size, GST_FD_MEMORY_FLAG_DONT_CLOSE);
		}
		s->wl = zwp_linux_buffer_params_v1_create_immed(params, c->width, c->height, c->fourcc, 0);
		wl_display_roundtrip(c->dpy);
		zwp_linux_buffer_params_v1_destroy(params);
		if (failed) { set_err(err, errlen, "compositor rejected dmabuf %.4s:0x%016lx", (char *)&c->fourcc, c->modifier); return -1; }
	}
	return 0;
}

static void free_slots(struct oc_capture *c) {
	for (int i = 0; i < POOL_SIZE; i++) {
		struct slot *s = &c->slots[i];
		for (int p = 0; p < MAX_PLANES; p++) {
			if (s->mem[p]) gst_memory_unref(s->mem[p]);
			if (s->fds[p] >= 0) close(s->fds[p]);
		}
		if (s->wl) wl_buffer_destroy(s->wl);
		if (s->bo) gbm_bo_destroy(s->bo);
		memset(s, 0, sizeof *s);
	}
}

static void slot_buffer_released(gpointer data, GstMiniObject *obj) {
	struct slot *s = data;
	pthread_mutex_lock(&s->c->mu);
	s->gst_refs--;
	pthread_mutex_unlock(&s->c->mu);
	wake(s->c);
}

static GstBuffer *slot_wrap(struct oc_capture *c, struct slot *s, int64_t pts_us) {
	GstBuffer *buf = gst_buffer_new();
	for (int p = 0; p < s->nplanes; p++) gst_buffer_append_memory(buf, gst_memory_ref(s->mem[p]));
	gst_buffer_add_video_meta_full(buf, GST_VIDEO_FRAME_FLAG_NONE, GST_VIDEO_FORMAT_DMA_DRM,
		c->width, c->height, s->nplanes, s->offsets, s->strides);
	GST_BUFFER_PTS(buf) = pts_us * 1000;
	gst_buffer_add_reference_timestamp_meta(buf, present_caps, pts_us * 1000, GST_CLOCK_TIME_NONE);
	pthread_mutex_lock(&c->mu);
	s->gst_refs++;
	pthread_mutex_unlock(&c->mu);
	gst_mini_object_weak_ref(GST_MINI_OBJECT(buf), slot_buffer_released, s);
	return buf;
}

static struct slot *free_slot(struct oc_capture *c) {
	struct slot *found = NULL;
	pthread_mutex_lock(&c->mu);
	for (int i = 0; i < POOL_SIZE && !found; i++) {
		struct slot *s = &c->slots[i];
		if (s->gst_refs == 0 && s != c->frame_slot) found = s;
	}
	pthread_mutex_unlock(&c->mu);
	return found;
}

/* ---- pipeline ---- */

static GstPadProbeReturn trace_probe(GstPad *pad, GstPadProbeInfo *info, gpointer name) {
	GstBuffer *b = GST_PAD_PROBE_INFO_BUFFER(info);
	GstReferenceTimestampMeta *ts = b ? gst_buffer_get_reference_timestamp_meta(b, present_caps) : NULL;
	if (ts) fprintf(stderr, "%s lag %.2f ms\n", (char *)name, (now_us() - (int64_t)(ts->timestamp / 1000)) / 1000.0);
	return GST_PAD_PROBE_OK;
}

/* A CPB of roughly one frame at 30 fps keeps frame sizes even, which keeps latency even. */
static int cpb_size(int kbps) { return kbps / 30 > 1 ? kbps / 30 : 1; }

static int build_pipeline(struct oc_capture *c, const oc_config *cfg, char *err, size_t errlen) {
	const char *enc, *enc_caps;
	switch (cfg->codec) {
	case OC_CODEC_H265:
		enc = "vah265enc b-frames=0 ref-frames=1 aud=false";
		enc_caps = "video/x-h265,profile=main,stream-format=byte-stream,alignment=au";
		break;
	case OC_CODEC_AV1:
		/* hierarchical-level=1 disables forward references, so frames are never held back. */
		enc = "vaav1enc ref-frames=1 hierarchical-level=1";
		enc_caps = "video/x-av1,stream-format=obu-stream,alignment=tu";
		break;
	default:
		enc = "vah264enc b-frames=0 ref-frames=1 aud=false";
		enc_caps = "video/x-h264,profile=high,stream-format=byte-stream,alignment=au";
	}
	char scale[64] = "";
	if (cfg->width > 0 && cfg->height > 0 && (cfg->width != c->width || cfg->height != c->height))
		snprintf(scale, sizeof scale, ",width=%d,height=%d", cfg->width, cfg->height);

	char desc[1024];
	snprintf(desc, sizeof desc,
		"appsrc name=src is-live=true format=time do-timestamp=false leaky-type=downstream max-buffers=2 "
		"! vapostproc ! video/x-raw(memory:VAMemory),format=NV12%s "
		"! %s name=enc rate-control=cbr bitrate=%d cpb-size=%d key-int-max=1024 target-usage=%d %s "
		"! %s "
		"! appsink name=sink sync=false max-buffers=4 drop=false",
		scale, enc, cfg->bitrate_kbps, cpb_size(cfg->bitrate_kbps), cfg->target_usage,
		getenv("EVERYWHERE_DESKTOP_ENC_EXTRA") ? getenv("EVERYWHERE_DESKTOP_ENC_EXTRA") : "", enc_caps);
	GError *gerr = NULL;
	c->pipeline = gst_parse_launch(desc, &gerr);
	if (!c->pipeline) {
		set_err(err, errlen, "pipeline: %s", gerr ? gerr->message : "unknown");
		g_clear_error(&gerr);
		return -1;
	}
	g_clear_error(&gerr);
	c->appsrc = gst_bin_get_by_name(GST_BIN(c->pipeline), "src");
	c->enc = gst_bin_get_by_name(GST_BIN(c->pipeline), "enc");
	c->appsink = gst_bin_get_by_name(GST_BIN(c->pipeline), "sink");

	GstVideoInfoDmaDrm info;
	gst_video_info_dma_drm_init(&info);
	gst_video_info_set_format(&info.vinfo, GST_VIDEO_FORMAT_DMA_DRM, c->width, c->height);
	info.drm_fourcc = c->fourcc;
	info.drm_modifier = c->modifier;
	GstCaps *caps = gst_video_info_dma_drm_to_caps(&info);
	g_object_set(c->appsrc, "caps", caps, NULL);
	gst_caps_unref(caps);

	if (trace_enabled()) {
		GstPad *p1 = gst_element_get_static_pad(c->enc, "sink"), *p2 = gst_element_get_static_pad(c->enc, "src");
		gst_pad_add_probe(p1, GST_PAD_PROBE_TYPE_BUFFER, trace_probe, "encin", NULL);
		gst_pad_add_probe(p2, GST_PAD_PROBE_TYPE_BUFFER, trace_probe, "encout", NULL);
		gst_object_unref(p1); gst_object_unref(p2);
	}
	if (gst_element_set_state(c->pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
		set_err(err, errlen, "pipeline failed to start");
		return -1;
	}
	return 0;
}

static void check_bus(struct oc_capture *c) {
	GstBus *bus = gst_element_get_bus(c->pipeline);
	GstMessage *msg;
	while ((msg = gst_bus_pop_filtered(bus, GST_MESSAGE_ERROR | GST_MESSAGE_EOS))) {
		if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
			GError *e = NULL;
			gchar *dbg = NULL;
			gst_message_parse_error(msg, &e, &dbg);
			fail(c, "encoder: %s (%s)", e ? e->message : "?", dbg ? dbg : "");
			g_clear_error(&e);
			g_free(dbg);
		} else {
			fail(c, "encoder: unexpected EOS");
		}
		gst_message_unref(msg);
	}
	gst_object_unref(bus);
}

static void push(struct oc_capture *c, struct slot *s, int64_t pts_us) {
	if (atomic_exchange(&c->want_keyframe, 0)) {
		GstPad *pad = gst_element_get_static_pad(c->enc, "sink");
		gst_pad_send_event(pad, gst_video_event_new_downstream_force_key_unit(
			GST_CLOCK_TIME_NONE, GST_CLOCK_TIME_NONE, GST_CLOCK_TIME_NONE, TRUE, 0));
		gst_object_unref(pad);
	}
	if (pts_us <= c->last_pts_us) pts_us = c->last_pts_us + 1000;
	c->last_pts_us = pts_us;
	GstBuffer *buf = slot_wrap(c, s, pts_us);
	if (c->last) gst_buffer_unref(c->last);
	c->last = gst_buffer_ref(buf);
	if (trace_enabled()) fprintf(stderr, "push lag %.2f ms\n", (now_us() - pts_us) / 1000.0);
	gst_app_src_push_buffer(GST_APP_SRC(c->appsrc), buf);
}

/* ---- frames ---- */

static void start_frame(struct oc_capture *c);

static void frame_transform(void *d, struct ext_image_copy_capture_frame_v1 *f, uint32_t t) {}
static void frame_damage(void *d, struct ext_image_copy_capture_frame_v1 *f, int32_t x, int32_t y, int32_t w, int32_t h) {}
static void frame_presentation_time(void *d, struct ext_image_copy_capture_frame_v1 *f, uint32_t hi, uint32_t lo, uint32_t nsec) {
	struct oc_capture *c = d;
	c->frame_present_us = ((int64_t)(((uint64_t)hi << 32) | lo)) * 1000000 + nsec / 1000;
}
static void frame_ready(void *d, struct ext_image_copy_capture_frame_v1 *f) {
	struct oc_capture *c = d;
	struct slot *s = c->frame_slot;
	int64_t pts = c->frame_present_us ? c->frame_present_us : now_us();
	ext_image_copy_capture_frame_v1_destroy(f);
	c->frame = NULL;
	c->frame_slot = NULL;
	push(c, s, pts);
	start_frame(c);
}
static void frame_failed(void *d, struct ext_image_copy_capture_frame_v1 *f, uint32_t reason) {
	struct oc_capture *c = d;
	ext_image_copy_capture_frame_v1_destroy(f);
	c->frame = NULL;
	c->frame_slot = NULL;
	if (reason == EXT_IMAGE_COPY_CAPTURE_FRAME_V1_FAILURE_REASON_STOPPED) fail(c, "capture stopped");
	else if (reason == EXT_IMAGE_COPY_CAPTURE_FRAME_V1_FAILURE_REASON_BUFFER_CONSTRAINTS) fail(c, "capture buffer constraints changed");
	else fail(c, "capture failed (reason %u)", reason);
}
static const struct ext_image_copy_capture_frame_v1_listener frame_listener = {
	.transform = frame_transform,
	.damage = frame_damage,
	.presentation_time = frame_presentation_time,
	.ready = frame_ready,
	.failed = frame_failed,
};

static void start_frame(struct oc_capture *c) {
	if (c->frame || atomic_load(&c->failed) || atomic_load(&c->closing)) return;
	int64_t now = now_us();
	if (c->frame_interval_us && now < c->next_frame_us) return;
	struct slot *s = free_slot(c);
	if (!s) return;
	c->next_frame_us = now + c->frame_interval_us;
	c->frame_slot = s;
	c->frame_present_us = 0;
	c->frame = ext_image_copy_capture_session_v1_create_frame(c->session);
	ext_image_copy_capture_frame_v1_add_listener(c->frame, &frame_listener, c);
	ext_image_copy_capture_frame_v1_attach_buffer(c->frame, s->wl);
	/* Slots rotate, so every buffer's contents are stale. */
	ext_image_copy_capture_frame_v1_damage_buffer(c->frame, 0, 0, c->width, c->height);
	ext_image_copy_capture_frame_v1_capture(c->frame);
}

static void *capture_thread(void *arg) {
	struct oc_capture *c = arg;
	int wl_fd = wl_display_get_fd(c->dpy);
	start_frame(c);
	while (!atomic_load(&c->closing) && !atomic_load(&c->failed)) {
		while (wl_display_prepare_read(c->dpy) != 0) wl_display_dispatch_pending(c->dpy);
		if (wl_display_flush(c->dpy) < 0 && errno != EAGAIN) {
			wl_display_cancel_read(c->dpy);
			fail(c, "Wayland connection lost");
			break;
		}
		struct pollfd fds[2] = { { wl_fd, POLLIN, 0 }, { c->wake_fd, POLLIN, 0 } };
		int timeout = 100;
		if (!c->frame && c->frame_interval_us) {
			int64_t wait = c->next_frame_us - now_us();
			if (wait < 0) wait = 0;
			if (wait / 1000 + 1 < timeout) timeout = (int)(wait / 1000) + 1;
		}
		int r = poll(fds, 2, timeout);
		if (r > 0 && (fds[0].revents & POLLIN)) {
			if (wl_display_read_events(c->dpy) < 0) { fail(c, "Wayland read failed"); break; }
		} else {
			wl_display_cancel_read(c->dpy);
		}
		if (r > 0 && (fds[0].revents & (POLLERR | POLLHUP))) { fail(c, "Wayland connection closed"); break; }
		if (wl_display_dispatch_pending(c->dpy) < 0) { fail(c, "Wayland protocol error %d", wl_display_get_error(c->dpy)); break; }

		if (r > 0 && (fds[1].revents & POLLIN)) {
			uint64_t v;
			if (read(c->wake_fd, &v, sizeof v) < 0) { /* spurious */ }
		}

		int br = atomic_exchange(&c->new_bitrate, 0);
		if (br > 0) g_object_set(c->enc, "bitrate", (guint)br, "cpb-size", (guint)cpb_size(br), NULL);

		/* A keyframe is needed but the screen may be static: re-encode the last frame. */
		if (atomic_load(&c->want_keyframe) && c->last) {
			struct slot *s = NULL;
			GstMemory *m = gst_buffer_peek_memory(c->last, 0);
			for (int i = 0; i < POOL_SIZE; i++) if (c->slots[i].mem[0] == m) s = &c->slots[i];
			if (s) push(c, s, now_us());
		}

		start_frame(c);
		check_bus(c);
	}
	return NULL;
}


/* ---- cursor ---- */

static void cursor_publish(struct oc_capture *c, int image_changed) {
	pthread_mutex_lock(&c->cursor_mu);
	if (image_changed) c->cursor.img_gen++;
	else c->cursor.pos_gen++;
	pthread_cond_broadcast(&c->cursor_cond);
	pthread_mutex_unlock(&c->cursor_mu);
}

static void cursor_enter(void *d, struct ext_image_copy_capture_cursor_session_v1 *cs) {
	struct oc_capture *c = d;
	pthread_mutex_lock(&c->cursor_mu);
	c->cursor.inside = 1;
	pthread_mutex_unlock(&c->cursor_mu);
	cursor_publish(c, 0);
}
static void cursor_leave(void *d, struct ext_image_copy_capture_cursor_session_v1 *cs) {
	struct oc_capture *c = d;
	pthread_mutex_lock(&c->cursor_mu);
	c->cursor.inside = 0;
	pthread_mutex_unlock(&c->cursor_mu);
	cursor_publish(c, 0);
}
static void cursor_position(void *d, struct ext_image_copy_capture_cursor_session_v1 *cs, int32_t x, int32_t y) {
	struct oc_capture *c = d;
	pthread_mutex_lock(&c->cursor_mu);
	c->cursor.x = x;
	c->cursor.y = y;
	pthread_mutex_unlock(&c->cursor_mu);
	cursor_publish(c, 0);
}
static void cursor_hotspot(void *d, struct ext_image_copy_capture_cursor_session_v1 *cs, int32_t x, int32_t y) {
	struct oc_capture *c = d;
	c->cursor.pending_hot_x = x;
	c->cursor.pending_hot_y = y;
}
static const struct ext_image_copy_capture_cursor_session_v1_listener cursor_session_listener = {
	.enter = cursor_enter,
	.leave = cursor_leave,
	.position = cursor_position,
	.hotspot = cursor_hotspot,
};

static void cursor_free_buffer(struct cursor *cur) {
	if (cur->buf) wl_buffer_destroy(cur->buf);
	if (cur->data) munmap(cur->data, (size_t)cur->buf_w * cur->buf_h * 4);
	cur->buf = NULL;
	cur->data = NULL;
	cur->buf_w = cur->buf_h = 0;
}

static int cursor_alloc_buffer(struct oc_capture *c) {
	struct cursor *cur = &c->cursor;
	if (cur->buf && cur->buf_w == cur->width && cur->buf_h == cur->height) return 0;
	cursor_free_buffer(cur);
	if (cur->width <= 0 || cur->height <= 0 || cur->width > 512 || cur->height > 512) return -1;
	size_t size = (size_t)cur->width * cur->height * 4;
	int fd = memfd_create("everywhere-cursor", MFD_CLOEXEC);
	if (fd < 0 || ftruncate(fd, size) < 0) { if (fd >= 0) close(fd); return -1; }
	cur->data = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (cur->data == MAP_FAILED) { cur->data = NULL; close(fd); return -1; }
	struct wl_shm_pool *pool = wl_shm_create_pool(c->shm, fd, size);
	cur->buf = wl_shm_pool_create_buffer(pool, 0, cur->width, cur->height, cur->width * 4, WL_SHM_FORMAT_ARGB8888);
	wl_shm_pool_destroy(pool);
	close(fd);
	cur->buf_w = cur->width;
	cur->buf_h = cur->height;
	return 0;
}

static void start_cursor_frame(struct oc_capture *c);

static void cframe_transform(void *d, struct ext_image_copy_capture_frame_v1 *f, uint32_t t) {}
static void cframe_damage(void *d, struct ext_image_copy_capture_frame_v1 *f, int32_t x, int32_t y, int32_t w, int32_t h) {}
static void cframe_presentation_time(void *d, struct ext_image_copy_capture_frame_v1 *f, uint32_t hi, uint32_t lo, uint32_t ns) {}
static void cframe_ready(void *d, struct ext_image_copy_capture_frame_v1 *f) {
	struct oc_capture *c = d;
	struct cursor *cur = &c->cursor;
	ext_image_copy_capture_frame_v1_destroy(f);
	cur->frame = NULL;

	int w = cur->buf_w, h = cur->buf_h;
	uint8_t *rgba = malloc((size_t)w * h * 4);
	if (trace_enabled()) {
		int nz = 0;
		for (int i = 0; i < w * h * 4; i++) nz += cur->data[i] != 0;
		fprintf(stderr, "cursor frame %dx%d nonzero bytes %d\n", w, h, nz);
	}
	for (int i = 0; i < w * h; i++) {
		/* wl_shm ARGB8888 is little-endian BGRA in memory, premultiplied. */
		uint8_t b = cur->data[i * 4], g = cur->data[i * 4 + 1], r = cur->data[i * 4 + 2], a = cur->data[i * 4 + 3];
		if (a && a != 255) {
			r = (uint8_t)(r * 255 / a);
			g = (uint8_t)(g * 255 / a);
			b = (uint8_t)(b * 255 / a);
		}
		rgba[i * 4] = r;
		rgba[i * 4 + 1] = g;
		rgba[i * 4 + 2] = b;
		rgba[i * 4 + 3] = a;
	}
	pthread_mutex_lock(&c->cursor_mu);
	free(cur->img);
	cur->img = rgba;
	cur->img_w = w;
	cur->img_h = h;
	cur->hot_x = cur->pending_hot_x;
	cur->hot_y = cur->pending_hot_y;
	pthread_mutex_unlock(&c->cursor_mu);
	cursor_publish(c, 1);
	start_cursor_frame(c);
}
static void cframe_failed(void *d, struct ext_image_copy_capture_frame_v1 *f, uint32_t reason) {
	struct oc_capture *c = d;
	ext_image_copy_capture_frame_v1_destroy(f);
	c->cursor.frame = NULL;
	/* buffer_constraints: a new "done" follows and restarts capture with a new buffer. */
	if (reason != EXT_IMAGE_COPY_CAPTURE_FRAME_V1_FAILURE_REASON_BUFFER_CONSTRAINTS) c->cursor.broken = 1;
}
static const struct ext_image_copy_capture_frame_v1_listener cursor_frame_listener = {
	.transform = cframe_transform,
	.damage = cframe_damage,
	.presentation_time = cframe_presentation_time,
	.ready = cframe_ready,
	.failed = cframe_failed,
};

static void start_cursor_frame(struct oc_capture *c) {
	struct cursor *cur = &c->cursor;
	if (!cur->session || cur->frame || cur->broken || !cur->session_done || !cur->has_argb) return;
	if (atomic_load(&c->closing) || atomic_load(&c->failed)) return;
	if (cursor_alloc_buffer(c) < 0) return;
	cur->frame = ext_image_copy_capture_session_v1_create_frame(cur->session);
	ext_image_copy_capture_frame_v1_add_listener(cur->frame, &cursor_frame_listener, c);
	ext_image_copy_capture_frame_v1_attach_buffer(cur->frame, cur->buf);
	ext_image_copy_capture_frame_v1_damage_buffer(cur->frame, 0, 0, cur->buf_w, cur->buf_h);
	ext_image_copy_capture_frame_v1_capture(cur->frame);
}

static void csession_buffer_size(void *d, struct ext_image_copy_capture_session_v1 *s, uint32_t w, uint32_t h) {
	struct oc_capture *c = d;
	c->cursor.width = w;
	c->cursor.height = h;
}
static void csession_shm_format(void *d, struct ext_image_copy_capture_session_v1 *s, uint32_t f) {
	if (trace_enabled()) fprintf(stderr, "cursor shm format 0x%x\n", f);
	if (f == WL_SHM_FORMAT_ARGB8888) ((struct oc_capture *)d)->cursor.has_argb = 1;
}
static void csession_dmabuf_device(void *d, struct ext_image_copy_capture_session_v1 *s, struct wl_array *a) {}
static void csession_dmabuf_format(void *d, struct ext_image_copy_capture_session_v1 *s, uint32_t f, struct wl_array *m) {
	if (trace_enabled()) fprintf(stderr, "cursor dmabuf format %.4s mods %zu\n", (char *)&f, m->size / 8);
}
static void csession_done(void *d, struct ext_image_copy_capture_session_v1 *s) {
	struct oc_capture *c = d;
	c->cursor.session_done = 1;
	start_cursor_frame(c);
}
static void csession_stopped(void *d, struct ext_image_copy_capture_session_v1 *s) {
	((struct oc_capture *)d)->cursor.broken = 1;
}
static const struct ext_image_copy_capture_session_v1_listener cursor_capture_listener = {
	.buffer_size = csession_buffer_size,
	.shm_format = csession_shm_format,
	.dmabuf_device = csession_dmabuf_device,
	.dmabuf_format = csession_dmabuf_format,
	.done = csession_done,
	.stopped = csession_stopped,
};

static void start_cursor_session(struct oc_capture *c) {
	if (!c->seat || !c->shm) return;
	c->pointer = wl_seat_get_pointer(c->seat);
	c->cursor.cs = ext_image_copy_capture_manager_v1_create_pointer_cursor_session(c->capmgr, c->source, c->pointer);
	ext_image_copy_capture_cursor_session_v1_add_listener(c->cursor.cs, &cursor_session_listener, c);
	c->cursor.session = ext_image_copy_capture_cursor_session_v1_get_capture_session(c->cursor.cs);
	ext_image_copy_capture_session_v1_add_listener(c->cursor.session, &cursor_capture_listener, c);
}

static void destroy_cursor(struct oc_capture *c) {
	struct cursor *cur = &c->cursor;
	if (cur->frame) ext_image_copy_capture_frame_v1_destroy(cur->frame);
	if (cur->session) ext_image_copy_capture_session_v1_destroy(cur->session);
	if (cur->cs) ext_image_copy_capture_cursor_session_v1_destroy(cur->cs);
	cursor_free_buffer(cur);
	free(cur->img);
	if (c->pointer) wl_pointer_destroy(c->pointer);
	if (c->seat) wl_seat_destroy(c->seat);
	if (c->shm) wl_shm_destroy(c->shm);
	memset(cur, 0, sizeof *cur);
}

/* ---- public API ---- */

static void destroy(struct oc_capture *c) {
	if (c->pipeline) gst_element_set_state(c->pipeline, GST_STATE_NULL);
	if (c->last) gst_buffer_unref(c->last);
	c->last = NULL;
	if (c->appsrc) gst_object_unref(c->appsrc);
	if (c->enc) gst_object_unref(c->enc);
	if (c->appsink) gst_object_unref(c->appsink);
	if (c->pipeline) gst_object_unref(c->pipeline);
	if (c->frame) ext_image_copy_capture_frame_v1_destroy(c->frame);
	destroy_cursor(c);
	free_slots(c);
	if (c->session) ext_image_copy_capture_session_v1_destroy(c->session);
	if (c->source) ext_image_capture_source_v1_destroy(c->source);
	for (int i = 0; i < c->ntoplevels; i++) ext_foreign_toplevel_handle_v1_destroy(c->toplevels[i].h);
	if (c->toplevel_srcmgr) ext_foreign_toplevel_image_capture_source_manager_v1_destroy(c->toplevel_srcmgr);
	if (c->toplevel_list) ext_foreign_toplevel_list_v1_destroy(c->toplevel_list);
	for (int i = 0; i < c->nformats; i++) free(c->formats[i].mods);
	for (int i = 0; i < c->noutputs; i++) wl_output_release(c->outputs[i].wl);
	if (c->srcmgr) ext_output_image_capture_source_manager_v1_destroy(c->srcmgr);
	if (c->capmgr) ext_image_copy_capture_manager_v1_destroy(c->capmgr);
	if (c->dmabuf) zwp_linux_dmabuf_v1_destroy(c->dmabuf);
	if (c->reg) wl_registry_destroy(c->reg);
	if (c->dpy) wl_display_disconnect(c->dpy);
	if (c->dmabuf_alloc) gst_object_unref(c->dmabuf_alloc);
	if (c->gbm) gbm_device_destroy(c->gbm);
	if (c->drm_fd > 0) close(c->drm_fd);
	if (c->wake_fd >= 0) close(c->wake_fd);
	pthread_mutex_destroy(&c->mu);
	pthread_mutex_destroy(&c->cursor_mu);
	pthread_cond_destroy(&c->cursor_cond);
	free(c);
}

oc_capture *oc_capture_start(const oc_config *cfg, char *err, size_t errlen) {
	gst_init(NULL, NULL);
	if (!present_caps) present_caps = gst_caps_new_empty_simple("timestamp/x-everywhere-present");
	struct oc_capture *c = calloc(1, sizeof *c);
	c->drm_fd = -1;
	pthread_mutex_init(&c->mu, NULL);
	pthread_mutex_init(&c->cursor_mu, NULL);
	pthread_cond_init(&c->cursor_cond, NULL);
	c->wake_fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
	c->dmabuf_alloc = gst_dmabuf_allocator_new();
	c->want_toplevels = cfg->window && *cfg->window;

	if (connect_wayland(c, err, errlen) < 0) goto fail;
	if (!c->srcmgr || !c->capmgr) { set_err(err, errlen, "compositor lacks ext-image-copy-capture-v1"); goto fail; }
	if (!c->dmabuf) { set_err(err, errlen, "compositor lacks linux-dmabuf-v1"); goto fail; }
	if (c->noutputs == 0) { set_err(err, errlen, "no outputs"); goto fail; }

	const char *want = (cfg->output && *cfg->output) ? cfg->output : "eDP-1";
	for (int i = 0; i < c->noutputs; i++)
		if (strcmp(c->outputs[i].name, want) == 0) c->output = &c->outputs[i];
	if (!c->output) {
		if (cfg->output && *cfg->output) { set_err(err, errlen, "no output named %s", cfg->output); goto fail; }
		c->output = &c->outputs[0];
	}

	if (c->want_toplevels) {
		if (!c->toplevel_list || !c->toplevel_srcmgr) { set_err(err, errlen, "compositor lacks window capture (ext-foreign-toplevel-image-capture-source)"); goto fail; }
		for (int i = 0; i < c->ntoplevels; i++)
			if (!c->toplevels[i].closed && strcmp(c->toplevels[i].id, cfg->window) == 0) c->window = &c->toplevels[i];
		if (!c->window) { set_err(err, errlen, "window closed"); goto fail; }
		c->source = ext_foreign_toplevel_image_capture_source_manager_v1_create_source(c->toplevel_srcmgr, c->window->h);
	} else {
		c->source = ext_output_image_capture_source_manager_v1_create_source(c->srcmgr, c->output->wl);
	}
	c->session = ext_image_copy_capture_manager_v1_create_session(c->capmgr, c->source,
		cfg->paint_cursor ? EXT_IMAGE_COPY_CAPTURE_MANAGER_V1_OPTIONS_PAINT_CURSORS : 0);
	ext_image_copy_capture_session_v1_add_listener(c->session, &session_listener, c);
	while (!c->session_done && !c->session_stopped)
		if (wl_display_dispatch(c->dpy) < 0) { set_err(err, errlen, "Wayland dispatch failed"); goto fail; }
	if (c->session_stopped) { set_err(err, errlen, "capture session refused by compositor"); goto fail; }
	if (!cfg->paint_cursor) start_cursor_session(c);

	uint64_t mods[32];
	size_t nmods = 0;
	if (choose_format(c, mods, &nmods, err, errlen) < 0) goto fail;
	if (open_render_node(c, err, errlen) < 0) goto fail;
	if (alloc_slots(c, mods, nmods, err, errlen) < 0) goto fail;
	if (cfg->max_fps > 0) c->frame_interval_us = 1000000 / cfg->max_fps;
	if (build_pipeline(c, cfg, err, errlen) < 0) goto fail;

	if (pthread_create(&c->thread, NULL, capture_thread, c) != 0) { set_err(err, errlen, "pthread_create failed"); goto fail; }
	c->thread_started = 1;
	return c;
fail:
	destroy(c);
	return NULL;
}

int oc_capture_pull(oc_capture *c, int timeout_ms, oc_sample *out) {
	if (atomic_load(&c->closing) || atomic_load(&c->failed)) return -1;
	GstSample *sample = gst_app_sink_try_pull_sample(GST_APP_SINK(c->appsink), (GstClockTime)timeout_ms * GST_MSECOND);
	if (!sample) return (atomic_load(&c->failed) || gst_app_sink_is_eos(GST_APP_SINK(c->appsink))) ? -1 : 0;
	GstBuffer *buf = gst_sample_get_buffer(sample);
	GstMapInfo map;
	if (!buf || !gst_buffer_map(buf, &map, GST_MAP_READ)) { gst_sample_unref(sample); return 0; }
	out->data = malloc(map.size);
	memcpy(out->data, map.data, map.size);
	out->len = map.size;
	GstReferenceTimestampMeta *ts = gst_buffer_get_reference_timestamp_meta(buf, present_caps);
	out->capture_us = ts ? (int64_t)(ts->timestamp / 1000) : 0;
	if (trace_enabled()) fprintf(stderr, "pull lag %.2f ms size %zu\n", (now_us() - out->capture_us) / 1000.0, map.size);
	out->keyframe = !GST_BUFFER_FLAG_IS_SET(buf, GST_BUFFER_FLAG_DELTA_UNIT);
	gst_buffer_unmap(buf, &map);
	gst_sample_unref(sample);
	return 1;
}

void oc_sample_free(oc_sample *s) {
	free(s->data);
	s->data = NULL;
}

void oc_capture_request_keyframe(oc_capture *c) {
	atomic_store(&c->want_keyframe, 1);
	wake(c);
}

void oc_capture_set_bitrate(oc_capture *c, int kbps) {
	atomic_store(&c->new_bitrate, kbps);
	wake(c);
}

void oc_capture_close(oc_capture *c) {
	atomic_store(&c->closing, 1);
	wake(c);
	pthread_mutex_lock(&c->cursor_mu);
	pthread_cond_broadcast(&c->cursor_cond);
	pthread_mutex_unlock(&c->cursor_mu);
}

void oc_capture_free(oc_capture *c) {
	oc_capture_close(c);
	if (c->thread_started) pthread_join(c->thread, NULL);
	destroy(c);
}

const char *oc_capture_error(oc_capture *c) { return atomic_load(&c->failed) ? c->err : ""; }
int oc_capture_width(oc_capture *c) { return c->width; }
int oc_capture_height(oc_capture *c) { return c->height; }
const char *oc_capture_output(oc_capture *c) { return c->output->name; }

char *oc_list_outputs(char *err, size_t errlen) {
	struct oc_capture *c = calloc(1, sizeof *c);
	c->drm_fd = -1;
	c->wake_fd = -1;
	pthread_mutex_init(&c->mu, NULL);
	pthread_mutex_init(&c->cursor_mu, NULL);
	pthread_cond_init(&c->cursor_cond, NULL);
	char *out = NULL;
	if (connect_wayland(c, err, errlen) == 0) {
		size_t cap = 64 + (size_t)c->noutputs * 96;
		out = calloc(1, cap);
		for (int i = 0; i < c->noutputs; i++) {
			char line[96];
			snprintf(line, sizeof line, "%s\t%d\t%d\n", c->outputs[i].name, c->outputs[i].width, c->outputs[i].height);
			strcat(out, line);
		}
	}
	destroy(c);
	return out;
}

int oc_capture_cursor_wait(oc_capture *c, uint64_t img_gen, uint64_t pos_gen, int timeout_ms, oc_cursor *out) {
	struct timespec deadline;
	clock_gettime(CLOCK_REALTIME, &deadline);
	deadline.tv_sec += timeout_ms / 1000;
	deadline.tv_nsec += (long)(timeout_ms % 1000) * 1000000;
	if (deadline.tv_nsec >= 1000000000) { deadline.tv_sec++; deadline.tv_nsec -= 1000000000; }

	pthread_mutex_lock(&c->cursor_mu);
	struct cursor *cur = &c->cursor;
	int r = 0;
	for (;;) {
		if (atomic_load(&c->closing) || atomic_load(&c->failed)) { r = -1; break; }
		if (cur->img_gen != img_gen || cur->pos_gen != pos_gen) { r = 1; break; }
		if (pthread_cond_timedwait(&c->cursor_cond, &c->cursor_mu, &deadline) == ETIMEDOUT) break;
	}
	if (r == 1) {
		out->img_gen = cur->img_gen;
		out->pos_gen = cur->pos_gen;
		out->inside = cur->inside;
		out->x = cur->x;
		out->y = cur->y;
		out->hot_x = cur->hot_x;
		out->hot_y = cur->hot_y;
		out->width = cur->img_w;
		out->height = cur->img_h;
		out->rgba = NULL;
		if (cur->img_gen != img_gen && cur->img) {
			size_t n = (size_t)cur->img_w * cur->img_h * 4;
			out->rgba = malloc(n);
			memcpy(out->rgba, cur->img, n);
		}
	}
	pthread_mutex_unlock(&c->cursor_mu);
	return r;
}
