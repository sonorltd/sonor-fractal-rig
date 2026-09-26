CC      ?= cc
CFLAGS  ?= -O2 -Wall -Wno-unused-result -Wno-misleading-indentation -Wno-unused-variable
PKGS     = sdl2 glesv2
CFLAGS  += $(shell pkg-config --cflags $(PKGS))
LDLIBS  += $(shell pkg-config --libs $(PKGS)) -lm

# libprojectM 4 is optional: built in automatically when pkg-config can see it
# (setup/install-projectm.sh builds it from source with GLES on a Pi).
HAVE_PM := $(shell pkg-config --exists projectM-4 && echo 1)
ifeq ($(HAVE_PM),1)
CFLAGS  += -DHAVE_PROJECTM $(shell pkg-config --cflags projectM-4 | sed 's/-DPROJECTM_STATIC_DEFINE//')
LDLIBS  += -L$(shell pkg-config --variable=libdir projectM-4) -lprojectM-4 -Wl,-rpath,$(shell pkg-config --variable=libdir projectM-4)
endif

# libmpv is optional: scene 9 (Video) decodes clips locally through the libmpv render API
# (apt install libmpv-dev ffmpeg — setup/install.sh does it). Without it scene 9 falls back to plasma.
HAVE_MPV := $(shell pkg-config --exists mpv && echo 1)
ifeq ($(HAVE_MPV),1)
CFLAGS  += -DHAVE_MPV $(shell pkg-config --cflags mpv)
LDLIBS  += $(shell pkg-config --libs mpv)
endif

# NDI is optional too: point NDI_SDK_DIR at the extracted SDK (setup/install-ndi.sh puts it in /usr/local)
NDI_INC := $(firstword $(wildcard $(NDI_SDK_DIR)/include/Processing.NDI.Lib.h /usr/local/include/Processing.NDI.Lib.h))
ifneq ($(NDI_INC),)
CFLAGS  += -DHAVE_NDI -I$(dir $(NDI_INC))
NDI_LIBDIR := $(firstword $(wildcard $(NDI_SDK_DIR)/lib/aarch64-rpi4-linux-gnueabi $(NDI_SDK_DIR)/lib/x86_64-linux-gnu /usr/local/lib))
LDLIBS  += -L$(NDI_LIBDIR) -lndi -Wl,-rpath,$(NDI_LIBDIR)
endif

fractal: fractal.c pm_bridge.c pm_bridge.h ndi_out.c ndi_out.h video_bridge.c video_bridge.h mapping.c mapping.h shaderlib.c shaderlib.h gpufx.c gpufx.h params.h shaders/params.glsl shaders/fractal.frag shaders/post.frag shaders/warp.frag shaders/mix.frag
	$(CC) $(CFLAGS) -o $@ fractal.c pm_bridge.c ndi_out.c video_bridge.c mapping.c shaderlib.c gpufx.c $(LDLIBS)
	@echo "built fractal — projectM: $(if $(HAVE_PM),yes,no) · NDI: $(if $(NDI_INC),yes,no) · video (libmpv): $(if $(HAVE_MPV),yes,no)"

params.h shaders/params.glsl: ../master/params.py ../master/gen_params.py
	python3 ../master/gen_params.py

deps:
	sudo apt-get install -y libsdl2-dev libgles2-mesa-dev libmpv-dev ffmpeg pkg-config build-essential

clean:
	rm -f fractal

.PHONY: deps clean
