#let question = sys.inputs.at("question")
#let author = sys.inputs.at("author")
#let subject = sys.inputs.at("subject")
#let logo-available = sys.inputs.at("logo_available", default: "false") == "true"
#let logo-path = sys.inputs.at("logo_path", default: "assets/logo.png")

#let accents = (
  "Mathematics": rgb("#8B7CFF"),
  "Physics": rgb("#42C7FF"),
  "Chemistry": rgb("#FFB64A"),
  "Biology": rgb("#55D69E"),
)
#let accent = accents.at(subject, default: rgb("#8B7CFF"))
#let question-size = if question.len() > 1000 {
  11.5pt
} else if question.len() > 850 {
  13pt
} else if question.len() > 700 {
  15pt
} else if question.len() > 550 {
  17pt
} else if question.len() > 400 {
  20pt
} else if question.len() > 280 {
  23pt
} else if question.len() > 180 {
  27pt
} else if question.len() > 110 {
  32pt
} else {
  38pt
}
#let rendered-question = eval(question, mode: "markup")

#set page(
  width: 960pt,
  height: 540pt,
  margin: 0pt,
  fill: rgb("#08111F"),
)
#set text(
  font: ("Inter", "Arial", "Liberation Sans"),
  fill: rgb("#F7FAFF"),
)
#set par(leading: 0.72em)

#place(top + left, dx: -100pt, dy: -150pt)[
  #circle(radius: 260pt, fill: accent.transparentize(82%))
]
#place(bottom + right, dx: 110pt, dy: 150pt)[
  #circle(radius: 245pt, fill: rgb("#A757FF").transparentize(88%))
]
#place(top + right, dx: -30pt, dy: 25pt)[
  #rotate(18deg)[
    #rect(width: 240pt, height: 10pt, radius: 5pt, fill: accent.transparentize(68%))
  ]
]

#pad(x: 54pt, y: 31pt)[
  #grid(
    columns: (1fr, auto),
    align: (left + horizon, right + horizon),
    column-gutter: 20pt,
    [
      #text(size: 13pt, weight: 700, tracking: 1.4pt, fill: accent)[CHAOTIC ASCENSION]
      #v(5pt)
      #text(size: 23pt, weight: 800)[CLASH OF PRODIGIES]
    ],
    [
      #if logo-available {
        image(logo-path, width: 55pt, height: 55pt, fit: "contain")
      } else {
        rect(
          inset: (x: 13pt, y: 9pt),
          radius: 8pt,
          stroke: 1pt + accent,
          text(size: 10pt, weight: 800, fill: accent)[COP],
        )
      }
    ],
  )

  #v(20pt)
  #box(
    fill: accent,
    radius: 10pt,
    inset: (x: 18pt, y: 8pt),
    text(size: 13pt, weight: 800, fill: rgb("#07101C"), tracking: 0.8pt)[#subject],
  )

  #v(14pt)
  #block(
    width: 100%,
    height: 270pt,
    fill: rgb("#111E32").transparentize(8%),
    radius: 18pt,
    stroke: 1pt + rgb("#FFFFFF").transparentize(88%),
    inset: 0pt,
  )[
    #grid(
      columns: (7pt, 1fr),
      column-gutter: 0pt,
      rect(width: 7pt, height: 270pt, fill: accent, radius: (top-left: 18pt, bottom-left: 18pt)),
      pad(x: 31pt, y: 25pt)[
        #block(width: 100%, height: 220pt)[
          #align(left + horizon)[
            #set text(size: question-size, weight: 650)
            #rendered-question
          ]
        ]
      ],
    )
  ]

  #v(13pt)
  #grid(
    columns: (auto, 1fr, auto),
    align: (left + horizon, left + horizon, right + horizon),
    column-gutter: 10pt,
    text(size: 11pt, weight: 700, fill: rgb("#AEBBD0"))[QUESTION AUTHOR],
    rect(width: 100%, height: 1pt, fill: rgb("#FFFFFF").transparentize(88%)),
    text(size: 16pt, weight: 750, fill: accent)[#author],
  )
]
