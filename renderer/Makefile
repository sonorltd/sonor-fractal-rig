CC      ?= cc
CFLAGS  ?= -O2 -Wall -Wno-unused-result
PKGS     = sdl2 glesv2
CFLAGS  += $(shell pkg-config --cflags $(PKGS))
LDLIBS  += $(shell pkg-config --libs $(PKGS)) -lm

fractal: fractal.c params.h shaders/params.glsl shaders/fractal.frag
	$(CC) $(CFLAGS) -o $@ fractal.c $(LDLIBS)

params.h shaders/params.glsl: ../master/params.py ../master/gen_params.py
	python3 ../master/gen_params.py

deps:
	sudo apt-get install -y libsdl2-dev libgles2-mesa-dev pkg-config build-essential

clean:
	rm -f fractal

.PHONY: deps clean
