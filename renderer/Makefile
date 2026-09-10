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

fractal: fractal.c pm_bridge.c pm_bridge.h params.h shaders/params.glsl shaders/fractal.frag shaders/post.frag
	$(CC) $(CFLAGS) -o $@ fractal.c pm_bridge.c $(LDLIBS)
	@echo "built fractal — projectM: $(if $(HAVE_PM),yes,no)"

params.h shaders/params.glsl: ../master/params.py ../master/gen_params.py
	python3 ../master/gen_params.py

deps:
	sudo apt-get install -y libsdl2-dev libgles2-mesa-dev pkg-config build-essential

clean:
	rm -f fractal

.PHONY: deps clean
