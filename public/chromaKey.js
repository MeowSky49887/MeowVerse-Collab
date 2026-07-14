class ChromaKey {
  constructor(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.running = false;
    this.enabled = false;

    this.settings = {
      r: 0,
      g: 255,
      b: 0,
      threshold: 0.35,
      smoothness: 0.12,
    };

    this.gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
    });

    if (!this.gl) {
      throw new Error("WebGL2 not supported");
    }

    this.sampleCanvas =
      document.createElement("canvas");

    this.sampleCtx =
      this.sampleCanvas.getContext(
        "2d",
        { willReadFrequently: true }
      );

    this.init();

    if (video.readyState >= 1) {
      this.resize();
      this.play();
    } else {
      video.addEventListener(
        "loadedmetadata",
        () => {
          this.resize();
          this.play();
        },
        { once: true }
      );
    }
  }

  resize() {
    if (
      !this.video.videoWidth ||
      !this.video.videoHeight
    ) {
      return;
    }

    this.canvas.width =
      this.video.videoWidth;

    this.canvas.height =
      this.video.videoHeight;


    this.sampleCanvas.width =
      this.video.videoWidth;

    this.sampleCanvas.height =
      this.video.videoHeight;


    this.gl.viewport(
      0,
      0,
      this.canvas.width,
      this.canvas.height
    );
  }

  init() {
    const gl = this.gl;

    const vs = `#version 300 es
    in vec2 aPosition;
    in vec2 aUV;

    out vec2 vUV;

    void main() {
      vUV = aUV;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
    `;

    const fs = `#version 300 es
    precision highp float;

    uniform sampler2D uVideo;
    uniform bool uEnabled;
    uniform vec3 uKeyColor;
    uniform float uThreshold;
    uniform float uSmoothness;

    in vec2 vUV;
    out vec4 outColor;

    void main() {
      vec4 color =
        texture(uVideo, vUV);

        if (!uEnabled) {
          outColor = color;
          return;
        }

      float dist =
        distance(
          color.rgb,
          uKeyColor
        );

      float alpha =
        smoothstep(
          uThreshold,
          uThreshold + uSmoothness,
          dist
        );

      vec3 rgb = color.rgb;

      // simple despill
      if (
        rgb.g > rgb.r &&
        rgb.g > rgb.b
      ) {
        float avg =
          (rgb.r + rgb.b) * 0.5;

        rgb.g =
          mix(
            avg,
            rgb.g,
            alpha
          );
      }

      outColor =
        vec4(rgb, alpha);
    }
    `;

    const shader = (type, source) => {
      const s =
        gl.createShader(type);

      gl.shaderSource(s, source);
      gl.compileShader(s);

      if (
        !gl.getShaderParameter(
          s,
          gl.COMPILE_STATUS
        )
      ) {
        throw new Error(
          gl.getShaderInfoLog(s)
        );
      }

      return s;
    };

    this.program =
      gl.createProgram();

    gl.attachShader(
      this.program,
      shader(
        gl.VERTEX_SHADER,
        vs
      )
    );

    gl.attachShader(
      this.program,
      shader(
        gl.FRAGMENT_SHADER,
        fs
      )
    );

    gl.linkProgram(
      this.program
    );

    if (
      !gl.getProgramParameter(
        this.program,
        gl.LINK_STATUS
      )
    ) {
      throw new Error(
        gl.getProgramInfoLog(
          this.program
        )
      );
    }

    gl.useProgram(
      this.program
    );

    const vertices =
      new Float32Array([
        // x y u v
        -1, -1, 0, 1,
         1, -1, 1, 1,
        -1,  1, 0, 0,

        -1,  1, 0, 0,
         1, -1, 1, 1,
         1,  1, 1, 0,
      ]);

    this.vao =
      gl.createVertexArray();

    gl.bindVertexArray(
      this.vao
    );

    const buffer =
      gl.createBuffer();

    gl.bindBuffer(
      gl.ARRAY_BUFFER,
      buffer
    );

    gl.bufferData(
      gl.ARRAY_BUFFER,
      vertices,
      gl.STATIC_DRAW
    );

    const aPosition =
      gl.getAttribLocation(
        this.program,
        "aPosition"
      );

    const aUV =
      gl.getAttribLocation(
        this.program,
        "aUV"
      );

    gl.enableVertexAttribArray(
      aPosition
    );

    gl.vertexAttribPointer(
      aPosition,
      2,
      gl.FLOAT,
      false,
      16,
      0
    );

    gl.enableVertexAttribArray(
      aUV
    );

    gl.vertexAttribPointer(
      aUV,
      2,
      gl.FLOAT,
      false,
      16,
      8
    );

    this.texture =
      gl.createTexture();

    gl.bindTexture(
      gl.TEXTURE_2D,
      this.texture
    );

    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR
    );

    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAG_FILTER,
      gl.LINEAR
    );

    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_WRAP_S,
      gl.CLAMP_TO_EDGE
    );

    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_WRAP_T,
      gl.CLAMP_TO_EDGE
    );

    this.uVideo =
      gl.getUniformLocation(
        this.program,
        "uVideo"
      );

    this.uEnabled =
      gl.getUniformLocation(
        this.program,
        "uEnabled"
      );

    this.uKeyColor =
      gl.getUniformLocation(
        this.program,
        "uKeyColor"
      );

    this.uThreshold =
      gl.getUniformLocation(
        this.program,
        "uThreshold"
      );

    this.uSmoothness =
      gl.getUniformLocation(
        this.program,
        "uSmoothness"
      );

    gl.uniform1i(
      this.uVideo,
      0
    );

    gl.uniform1i(
      this.uEnabled,
      0
    );

    gl.clearColor(
      0,
      0,
      0,
      0
    );

    gl.enable(gl.BLEND);

    gl.blendFunc(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA
    );

    this.setKey();
  }

  setKey(options) {
    const gl = this.gl;

    gl.useProgram(
      this.program
    );

    if (!options) {
      this.enabled = false;

      gl.uniform1i(
        this.uEnabled,
        0
      );

      return;
    }

    Object.assign(
      this.settings,
      options
    );

    const {
      r,
      g,
      b,
      threshold,
      smoothness,
    } = this.settings;


    this.enabled = true;

    gl.uniform1i(
      this.uEnabled,
      1
    );

    gl.uniform3f(
      this.uKeyColor,
      r / 255,
      g / 255,
      b / 255
    );

    gl.uniform1f(
      this.uThreshold,
      threshold * 0.5
    );

    gl.uniform1f(
      this.uSmoothness,
      smoothness * 0.25
    );
  }

  checkAlpha(x, y) {
    if (!this.enabled) {
      return 255;
    }

    const i =
      (y * this.video.videoWidth + x) * 4;

    const data = this.frame;

    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;

    const kr =
      this.settings.r / 255;

    const kg =
      this.settings.g / 255;

    const kb =
      this.settings.b / 255;

    const dist = Math.sqrt(
      (r - kr) * (r - kr) +
      (g - kg) * (g - kg) +
      (b - kb) * (b - kb)
    );

    const edge0 =
      this.settings.threshold;

    const edge1 =
      edge0 +
      this.settings.smoothness;

    let t =
      (dist - edge0) /
      (edge1 - edge0);

    t =
      Math.max(
        0,
        Math.min(1, t)
      );

    t =
      t * t * (3 - 2 * t);

    return Math.round(
      t * 255
    );
  }

  render() {
    const gl = this.gl;

    if (
      this.video.readyState < 2
    ) {
      return;
    }

    gl.activeTexture(
      gl.TEXTURE0
    );

    gl.bindTexture(
      gl.TEXTURE_2D,
      this.texture
    );

    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.video
    );

    gl.clear(
      gl.COLOR_BUFFER_BIT
    );

    gl.bindVertexArray(
      this.vao
    );

    gl.drawArrays(
      gl.TRIANGLES,
      0,
      6
    );

    this.sampleCtx.drawImage(
      this.video,
      0,
      0
    );

    this.frame =
      this.sampleCtx.getImageData(
        0,
        0,
        this.video.videoWidth,
        this.video.videoHeight
      ).data;
  }

  play() {
    if (this.running) {
      return;
    }

    this.running = true;

    if (
      "requestVideoFrameCallback" in
      this.video
    ) {
      const loop = () => {
        if (!this.running) {
          return;
        }

        this.render();

        this.video
          .requestVideoFrameCallback(
            loop
          );
      };

      this.video
        .requestVideoFrameCallback(
          loop
        );
    } else {
      const loop = () => {
        if (!this.running) {
          return;
        }

        this.render();

        requestAnimationFrame(
          loop
        );
      };

      requestAnimationFrame(
        loop
      );
    }
  }

  pause() {
    this.running = false;
  }

  destroy() {
    this.pause();

    const gl = this.gl;

    gl.deleteTexture(
      this.texture
    );

    gl.deleteVertexArray(
      this.vao
    );

    gl.deleteProgram(
      this.program
    );
  }
}