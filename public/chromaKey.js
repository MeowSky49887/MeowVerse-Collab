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
      preserveDrawingBuffer: true,
    });

    if (!this.gl) {
      throw new Error("WebGL2 not supported");
    }

    // Final alpha buffer used by checkAlpha().
    this.frame = null;

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

  resize(width, height) {
    if (
      !this.video.videoWidth ||
      !this.video.videoHeight
    ) {
      return;
    }

    const w =
      width || this.video.videoWidth;

    const h =
      height || this.video.videoHeight;

    this.canvas.width = w;
    this.canvas.height = h;

    this.gl.viewport(
      0,
      0,
      w,
      h
    );

    // Readback buffer must use the actual video dimensions.
    this.readWidth = this.video.videoWidth;
    this.readHeight = this.video.videoHeight;

    this.frame = new Uint8Array(
      this.readWidth *
      this.readHeight *
      4
    );

    this.createReadbackFramebuffer(
      this.readWidth,
      this.readHeight
    );
  }

  createReadbackFramebuffer(width, height) {
    const gl = this.gl;

    if (this.readFramebuffer) {
      gl.deleteFramebuffer(
        this.readFramebuffer
      );

      gl.deleteTexture(
        this.readTexture
      );
    }

    this.readFramebuffer =
      gl.createFramebuffer();

    this.readTexture =
      gl.createTexture();

    gl.bindTexture(
      gl.TEXTURE_2D,
      this.readTexture
    );

    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.NEAREST
    );

    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAG_FILTER,
      gl.NEAREST
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

    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );

    gl.bindFramebuffer(
      gl.FRAMEBUFFER,
      this.readFramebuffer
    );

    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.readTexture,
      0
    );

    const status =
      gl.checkFramebufferStatus(
        gl.FRAMEBUFFER
      );

    if (
      status !== gl.FRAMEBUFFER_COMPLETE
    ) {
      throw new Error(
        "Readback framebuffer is incomplete"
      );
    }

    gl.bindFramebuffer(
      gl.FRAMEBUFFER,
      null
    );

    gl.bindTexture(
      gl.TEXTURE_2D,
      null
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
      gl_Position =
        vec4(aPosition, 0.0, 1.0);
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

      // Native alpha from the video.
      float videoAlpha =
        color.a;

      // No chroma key:
      // preserve the video's original alpha.
      if (!uEnabled) {
        outColor = color;
        return;
      }

      float dist =
        distance(
          color.rgb,
          uKeyColor
        );

      float keyAlpha =
        smoothstep(
          uThreshold,
          uThreshold + uSmoothness,
          dist
        );

      // Chroma key alpha is multiplied
      // by the video's existing alpha.
      float finalAlpha =
        videoAlpha * keyAlpha;

      vec3 rgb =
        color.rgb;

      // Despill.
      if (
        rgb.g > rgb.r &&
        rgb.g > rgb.b
      ) {
        float avg =
          (rgb.r + rgb.b) * 0.5;

        // Only despill visible pixels.
        rgb.g =
          mix(
            avg,
            rgb.g,
            keyAlpha
          );
      }

      outColor =
        vec4(
          rgb,
          finalAlpha
        );
    }
    `;

    const compileShader =
      (type, source) => {
        const shader =
          gl.createShader(type);

        gl.shaderSource(
          shader,
          source
        );

        gl.compileShader(
          shader
        );

        if (
          !gl.getShaderParameter(
            shader,
            gl.COMPILE_STATUS
          )
        ) {
          const log =
            gl.getShaderInfoLog(
              shader
            );

          gl.deleteShader(shader);

          throw new Error(log);
        }

        return shader;
      };

    this.program =
      gl.createProgram();

    const vertexShader =
      compileShader(
        gl.VERTEX_SHADER,
        vs
      );

    const fragmentShader =
      compileShader(
        gl.FRAGMENT_SHADER,
        fs
      );

    gl.attachShader(
      this.program,
      vertexShader
    );

    gl.attachShader(
      this.program,
      fragmentShader
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

    gl.deleteShader(
      vertexShader
    );

    gl.deleteShader(
      fragmentShader
    );

    gl.useProgram(
      this.program
    );

    const vertices =
      new Float32Array([
        // x, y, u, v

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

    this.buffer =
      gl.createBuffer();

    gl.bindBuffer(
      gl.ARRAY_BUFFER,
      this.buffer
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

    gl.bindVertexArray(null);

    // Video texture.
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

    gl.bindTexture(
      gl.TEXTURE_2D,
      null
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

    gl.useProgram(
      this.program
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

    // Important:
    // allow transparent output.
    gl.enable(
      gl.BLEND
    );

    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
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

  render() {
    const gl = this.gl;

    if (
      this.video.readyState < 2
    ) {
      return;
    }

    gl.useProgram(
      this.program
    );

    // Upload video frame.
    gl.activeTexture(
      gl.TEXTURE0
    );

    gl.bindTexture(
      gl.TEXTURE_2D,
      this.texture
    );

    /*
     * Important:
     *
     * Do NOT use the 2D canvas here.
     *
     * The video texture is allowed to retain
     * its native alpha channel.
     */
    gl.pixelStorei(
      gl.UNPACK_FLIP_Y_WEBGL,
      false
    );

    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.video
    );

    // Draw to visible canvas.
    gl.bindFramebuffer(
      gl.FRAMEBUFFER,
      null
    );

    gl.viewport(
      0,
      0,
      this.canvas.width,
      this.canvas.height
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

    /*
     * Render again to an offscreen framebuffer
     * so checkAlpha() can obtain the final alpha.
     */
    if (
      this.readFramebuffer &&
      this.frame
    ) {
      gl.bindFramebuffer(
        gl.FRAMEBUFFER,
        this.readFramebuffer
      );

      gl.viewport(
        0,
        0,
        this.readWidth,
        this.readHeight
      );

      gl.clear(
        gl.COLOR_BUFFER_BIT
      );

      gl.drawArrays(
        gl.TRIANGLES,
        0,
        6
      );

      gl.readPixels(
        0,
        0,
        this.readWidth,
        this.readHeight,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.frame
      );

      gl.bindFramebuffer(
        gl.FRAMEBUFFER,
        null
      );

      // Restore visible canvas viewport.
      gl.viewport(
        0,
        0,
        this.canvas.width,
        this.canvas.height
      );
    }

    gl.bindVertexArray(null);
  }

  checkAlpha(x, y) {
    if (!this.frame) {
      return 0;
    }

    if (
      x < 0 ||
      y < 0 ||
      x >= this.readWidth ||
      y >= this.readHeight
    ) {
      return 0;
    }

    /*
     * WebGL readPixels has its origin at the
     * bottom-left, while video coordinates usually
     * have their origin at the top-left.
     */
    const glY =
      this.readHeight - 1 - y;

    const i =
      (
        glY * this.readWidth +
        x
      ) * 4;

    return this.frame[i + 3];
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

        this.video.requestVideoFrameCallback(
          loop
        );
      };

      this.video.requestVideoFrameCallback(
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

    if (this.texture) {
      gl.deleteTexture(
        this.texture
      );
    }

    if (this.readTexture) {
      gl.deleteTexture(
        this.readTexture
      );
    }

    if (this.readFramebuffer) {
      gl.deleteFramebuffer(
        this.readFramebuffer
      );
    }

    if (this.vao) {
      gl.deleteVertexArray(
        this.vao
      );
    }

    if (this.buffer) {
      gl.deleteBuffer(
        this.buffer
      );
    }

    if (this.program) {
      gl.deleteProgram(
        this.program
      );
    }
  }
}