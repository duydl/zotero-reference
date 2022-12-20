import AddonModule from "./module";
import { Addon } from "./addon";

class Utils extends AddonModule {

  constructor(parent: Addon) {
    console.log("Utils constructor")
    super(parent);
  }

  async getDOIInfo(DOI: string) {
    let data
    if (DOI in this.Addon.DOIData) {
      data = this.Addon.DOIData[DOI]
    } else {
      const configs = {
        semanticscholar: {
          url: `https://api.semanticscholar.org/graph/v1/paper/${DOI}?fields=title,year,authors`,
          parse: (response) => {
            let author = response.authors[0].name
            let title = response.title
            let year = response.year
            return {
              author, title, year
            }
          }
        },
        unpaywall: {
          url: `https://api.unpaywall.org/v2/${DOI}?email=zoterostyle@polygon.org`,
          parse: (response) => {
            let author = response.z_authors[0].family
            let title = response.title
            let year = response.year
            return {
              author, title, year
            }
          }
        }
      }
      for (let method in configs) {
        let res = await this.Zotero.HTTP.request(
          "GET",
          configs[method].url,
          {
            responseType: "json"
          }
        )
        if (res.status == 200) {
          data = configs[method].parse(res.response)
          this.debug(data)
          this.Addon.DOIData[DOI] = data
          break
        }
      }
    }
    return data
  }

  async getTitleInfo(title: string) {
    console.log("getTitleInfo", title)
    let data
    const key = `readpaper - ${title}`
    if (key in this.Addon.DOIData) {
      data = this.Addon.DOIData[key]
    } else {
      const readpaperApi = "https://readpaper.com/api/microService-app-aiKnowledge/aiKnowledge/paper/search"
      let res = await this.Zotero.HTTP.request(
        "POST",
        readpaperApi,
        {
          responseType: "json",
          headers: {
						"Content-Type": "application/json"
					},
          body: JSON.stringify({
            keywords: title,
            page: 1,
            pageSize: 1,
            searchType: 0
          })
        }
      )
      data = res.response?.data?.list[0]
      if (data) {
        // TODO: 评价匹配成功度，低不返回
        this.Addon.DOIData[key] = data
      } else {
        data = []
      }
    }
    return data
  }

  async getTitleDOIByCrossref(title: string) {
    let res
    try {
      this.Addon.views.showProgressWindow("通过crossref查询DOI", title)
      const crossref = `https://api.crossref.org/works?query=${title}`
      res = await this.Zotero.HTTP.request(
        "GET",
        crossref,
        {
          responseType: "json"
        }
      )
      const DOI = res.response.message.items.filter(e=>e.type != "component")[0].DOI
      this.debug(`getTitleDOIByCrossref(${title}) -> ${DOI}`)
      return DOI
    } catch {
      this.debug("error, getTitleDOIByCrossref", res.response)
      return false
    }
  }

  async getTitleDOIByUnpaywall(title: string) {
    let res
    try {
      this.Addon.views.showProgressWindow("通过unpaywall查询DOI", title)
      const unpaywall = `https://api.unpaywall.org/v2/search?query=${title}&email=zoterostyle@polygon.org`
      res = await this.Zotero.HTTP.request(
        "GET",
        unpaywall,
        {
          responseType: "json"
        }
      )
      const DOI = res.response.results[0].response.doi
      this.debug(`getTitleDOIByUnpaywall(${title}) -> ${DOI}`)
      return DOI
    } catch {
      this.debug("error, getTitleDOIByUnpayWall", res.response)
      return false
    }
  }

  async getTitleDOI(title: string) {
    let DOI = await this.getTitleDOIByUnpaywall(title)
    if (!DOI) {
      DOI = await this.getTitleDOIByCrossref(title)
    }
    this.Addon.views.showProgressWindow("DOI", DOI)
    return DOI
  }

  async getRefDataFromCrossref(DOI: string) {
    let refData = await this.getRefDataFromPDF()
    if (refData.length > 0) {
      return refData
    }
    // request or read data
    this.Addon.views.showProgressWindow("Crossref", `从Crossref API获取参考文献`)
    if (DOI in this.Addon.DOIRefData) {
      refData = this.Addon.DOIRefData[DOI]
    } else {
      try {
        const crossrefApi = `https://api.crossref.org/works/${DOI}/transform/application/vnd.citationstyles.csl+json`
        let res = await this.Zotero.HTTP.request(
          "GET",
          crossrefApi,
          {
            responseType: "json"
          }
        )
        refData = res.response.reference || []
        if (refData) {
          refData.forEach(ref => {
            if (ref.unstructured) {
              this.unpackUnstructured(ref)
            }
          })
          this.Addon.DOIRefData[DOI] = refData
        } else {
          return await this.getRefDataFromPDF()
        }
        this.Addon.views.showProgressWindow("Crossref", `获取${refData.length}条参考文献`, "success")
      } catch (e) {
        this.Addon.views.showProgressWindow("Crossref", e, "fail")
        return await this.getRefDataFromPDF()
      }
    }
    // analysis refData
    return refData
  }

  async getRefDataFromCNKI(URL: string) {
    let refData = await this.getRefDataFromPDF()
    if (refData.length > 0) {
      return refData
    }
    this.Addon.views.showProgressWindow("CNKI", `从知网获取参考文献`, "success")
    if (URL in this.Addon.DOIRefData) {
      refData = this.Addon.DOIRefData[URL]
    } else {
      this.debug("get by CNKI", URL)
      // URL - https://kns.cnki.net/kcms/detail/detail.aspx?dbcode=CJFD&dbname=CJFDLAST2022&filename=ZYJH202209006&uniplatform=NZKPT&v=4RWl_k1sYrO5ij1n5KXGDdusm5zXyjI12tpcPkSPI4OMnblizxXSTsDcSTbO-AqK
      //       https://kns.cnki.net/kcms/detail/frame/list.aspx?dbcode=CJFD&filename=zyjh202209006&RefType=1&vl=
      let args = this.parseCnkiURL(URL)
      let htmltext
      htmltext = (await this.Zotero.HTTP.request(
        "GET",
        URL,
        {
          responseType: "text"
        }
      )).response
      const vl = htmltext.match(/id="v".+?value="(.+?)"/)[1]
      this.debug("vl", vl);
      let page = 0;
      let parser = new this.window.DOMParser();
      while (true) {
        page++
        this.debug("page", page)
        if (page >= 6) { break }
        htmltext = (await this.Zotero.HTTP.request(
          "GET",
          `https://kns.cnki.net/kcms/detail/frame/list.aspx?dbcode=${args.DbCode}&filename=${args.FileName}&RefType=1&vl=${vl}&page=${page}`,
          {
            reponseType: "text",
            headers: {
              "Referer": `https://kns.cnki.net/kcms/detail/detail.aspx?filename=${args.FileName}`
            }
          }
        )).response
        const HTML = parser.parseFromString(htmltext, "text/html").body as HTMLElement
        let liNodes = [...HTML.querySelectorAll("ul li")]
        if (liNodes.length == 0) { break }
        this.Addon.views.showProgressWindow("CNKI", `获取第${page}页参考文献`, "success")
        liNodes.forEach((li: HTMLLIElement) => {
            let data = {}
            let a = li.querySelector("a[href]")
            if (a) {
              try {
                let _args = this.parseCnkiURL(a.getAttribute("href"))
                data["URL"] = `https://kns.cnki.net/kcms/detail/detail.aspx?FileName=${_args.FileName}&DbName=${_args.DbName}&DbCode=${_args.DbCode}`
              } catch {}
            }
            data["unstructured"] = li.innerText
              .replace(/\n/g, "")
              .replace(/\[\d+?\]/g, "")
              .replace(/\s+/g, " ")
              .trim()
            refData.push(data)
          })
      }
      if (refData) {
        this.Addon.DOIRefData[URL] = refData
      } else {
        return this.getRefDataFromPDF()
      }
    }
    return refData;
  }

  async getRefDataFromPDF() {
    let tabContainer = this.Addon.views.getTabContainer()
    if (!tabContainer.querySelector("#zotero-reference-tabpanel").classList.contains("PDF")) {
      return []
    }
    // try {
    let refLines = await this.getRefLines()
    if (refLines.length == 0) {
      this.Addon.views.showProgressWindow("PDF", "解析失败", "fail")
      return []
    }

    let refData = this.mergeSameRef(refLines)
    
    if (refData.length > 0) {
      this.Addon.views.showProgressWindow("PDF", `${refData.length}条参考文献`, "success")
    } else {
      this.Addon.views.showProgressWindow("PDF", `解析失败`, "fail")
    }

    this.debug(refData)
    for (let i = 0; i < refData.length; i++) {
      let ref = refData[i]
      let unstructured = ref.text
      unstructured = unstructured
        .trim()
        .replace(/^\[\d+\]/, "").replace(/^\d+[\.\s]?/, "").trim()
      ref["unstructured"] = unstructured
      this.unpackUnstructured(ref)
    }
    return refData
    // } catch (e) {
    //   console.error(e)
    //   this.Addon.views.showProgressWindow("PDF", e, "fail")
    //   return []
    // }
  }

  public unpackUnstructured(ref) {
    const regex = {
      "DOI": this.Addon.DOIRegex,
      "URL": /https?:\/\/[^\s]+/
    }
    for (let key in regex) {
      if (key in ref) { continue }
      let matchedRes = (ref?.url || "").match(regex[key]) || ref.unstructured.match(regex[key])
      if (matchedRes) {
        let value = matchedRes[0] as string
        ref[key] = value
      }
    }
  }

  public recordLayout(lines, middle) {
    let leftLines = lines.filter(line => line.x < middle)
    let rightLines
    rightLines = lines.filter(line => line.x > middle)
    if (leftLines) {
      let values = leftLines.map(line => line.x + line.width).sort((a, b) => b - a)
      let value = values.reduce((a, b) => a + b) / values.length;
      console.log(values, value)
      rightLines = rightLines.filter(line => line.x > value)
      leftLines = lines.filter(line=>rightLines.indexOf(line) == -1)
    }
    console.log("left", leftLines, "right", rightLines)

    // 找到左右分栏的最左端
    let leftSortedX = leftLines.map(line => line.x).sort((a, b) => a - b)
    let rightSortedX = rightLines.map(line => line.x).sort((a, b) => a - b)
    console.log(leftSortedX, rightSortedX)
    // 去除只出现几次的异常值
    let minTotalNum = 3
    let n = 1
    if (leftSortedX.length > minTotalNum) {
      leftSortedX = leftSortedX.filter(x => {
        return leftLines.filter(line=>line.x == x).length > n
      })
    }
    if (rightSortedX.length > minTotalNum) {
      rightSortedX = rightSortedX.filter(x => {
        return rightLines.filter(line=>line.x == x).length > n
      })
    }
    console.log(leftSortedX, rightSortedX)

    if (leftSortedX) {
      leftLines.forEach(line => {
        line["column"] = {
          side: "left",
          minX: leftSortedX[0]
        }
      })
    }
    if (rightSortedX) {
      rightLines.forEach(line => {
        line["column"] = {
          side: "right",
          minX: rightSortedX[0]
        }
      })
    }
    return [leftSortedX, rightSortedX]
  }

  public mergeSameTop(items) {
    let toLine = (item) => {
      return {
        x: parseFloat(item.transform[4].toFixed(1)),
        y: parseFloat(item.transform[5].toFixed(1)),
        text: item.str || "",
        height: item.height,
        width: item.width,
        url: item?.url,
      }
    }
    let j = 0
    let lines = [toLine(items[j])]
    for (j = 1; j < items.length; j++) {
      let line = toLine(items[j])
      let lastLine = lines.slice(-1)[0]
      let error = line.y - lastLine.y
      error = error > 0 ? error : -error
      if (error < line.height * .5 && lastLine.y - line.y < 2 * line.height) {
        lastLine.text += " " + line.text
        lastLine.width += line.width
        lastLine.url = lastLine.url || line.url
      } else {
        lines.push(line)
      }
    }
    return lines
  }

  public mergeSameLine(items) {

    let toLine = (item) => {
      return {
        x: parseFloat(item.transform[4].toFixed(1)),
        y: parseFloat(item.transform[5].toFixed(1)),
        text: item.str || "",
        height: item.height,
        width: item.width,
        url: item?.url,
      }
    }

    let j = 0
    let lines = [toLine(items[j])]
    for (j = 1; j < items.length; j++) {
      let line = toLine(items[j])
      let lastLine = lines.slice(-1)[0]
      let error = line.y - lastLine.y
      error = error > 0 ? error : -error
      if (error < line.height) {
        lastLine.text += " " + line.text
        lastLine.width += line.width
        lastLine.url = lastLine.url || line.url
        lastLine.height = line.height
      } else {
        lines.push(line)
      }
    }
    return lines
  }

  public isRefStart(text) {
    let regexArray = [
      [/^\[\d{0,3}\].+?[\,\.\uff0c\uff0e]?/],
      [/^\d+[^\d]+?[\,\.\uff0c\uff0e]?/],
      [/^[A-Z][A-Za-z]+[\,\.\uff0c\uff0e]?/, /^.+?,.+.,/, /^[\u4e00-\u9fa5]{1,4}[\,\.\uff0c\uff0e]?/],
    ]
    for (let i = 0; i < regexArray.length; i++) {
      let flags = new Set(regexArray[i].map(regex => regex.test(text.replace(/\s+/g, ""))))
      if (flags.has(true)) {
          return [true, i]
      }
    }
    return [false, -1]
  }

  public mergeSameRef(refLines) {
    let firstLine = refLines[0]
    // 已知新一行参考文献缩进
    let firstX = firstLine.x
    let secondLine = refLines.slice(1).find(line => {
      return this.abs(line.x - firstX) < 10 * firstLine.height
    })
    let delta = firstX - secondLine.x
    console.log("delta", delta)
    let [_, refType] = this.isRefStart(firstLine.text)
    console.log(firstLine.text, refType)
    let ref
    for (let i = 0; i < refLines.length; i++) {
      let line = refLines[i]
      let text = line.text 
      let isRef = this.isRefStart(text)
      if (
        // this.abs(line.x - firstX) < line.height * 1.2 &&
        isRef[0] &&
        isRef[1] == refType &&
        refLines.find(_line => {
          return (
            line != _line &&
            _line.column == line.column &&
            _line.pageNum == line.pageNum &&
            (line.x - _line.x) * delta > 0
          )
        }) !== undefined
      ) {
        console.log("->", line.text, isRef, refLines.find(_line => {
          return line != _line && _line.pageNum == line.pageNum && (line.x - _line.x) * delta > 0
        }))
        ref = line
      } else {
        if (ref && this.abs(this.abs(ref.x - line.x) - this.abs(delta)) > 5 * line.height) {
          refLines = refLines.slice(0, i)
          console.log("x", line.text, this.abs(this.abs(ref.x - line.x) - this.abs(delta)), 5 * line.height)
          break
        }
        console.log("+", text)
        ref.text += text
        if (line.url) {
          ref.url = line.url
        }
        refLines[i] = false
      }
    }
    return refLines.filter(e => e)
  }

  public updateItemsAnnotions(items, annotations) {
    // annotations {rect: [416, 722, 454, 733]}
    // items {transform: [...x, y], width: 82}
    let toBox = (rect) => {
      let [left, bottom, right, top] = rect;
      return {left, bottom, right, top}
    }

    let isIntersect = (A, B) => {
      if (
        B.right < A.left || 
        B.left > A.right || 
        B.bottom > A.top ||
        B.top < A.bottom
      ) {
        return false
      } else {
        return true
      }
    }

    annotations.forEach(annotation => {
      let annoBox = toBox(annotation.rect)
      items.forEach(item => {
        let [x, y] = item.transform.slice(4)
        let itemBox = toBox([x, y, x + item.width, y + item.height])
        if (isIntersect(annoBox, itemBox)) {
          item["url"] = annotation?.url || annotation?.unsafeUrl
        }
      })
    })
  }

  async readPdfPage(pdfPage) {
    let textContent = await pdfPage.getTextContent()
    let items = textContent.items.filter(item=>item.str.trim().length)
    let annotations = (await pdfPage.getAnnotations())

    // add URL to item with annotation
    this.updateItemsAnnotions(items, annotations)

    // merge items with the same y to lines
    let lines = this.mergeSameLine(items);
    `{
      x: parseFloat(item.transform[4].toFixed(1)),
      y: parseFloat(item.transform[5].toFixed(1)),
      text: item.str || "",
      height: item.height,
      width: item.width,
      url: item?.url,
    }`
    return lines
  }

  async getRefLines() {
    const PDFViewerApplication = this.Addon.views.reader._iframeWindow.wrappedJSObject.PDFViewerApplication;
    await PDFViewerApplication.pdfLoadingTask.promise;
    await PDFViewerApplication.pdfViewer.pagesPromise;
    let pages = PDFViewerApplication.pdfViewer._pages;
    // skip the pdf with page less than 3
    let pageLines = {};
    // read 2 page to remove head and tail
    let maxWidth, maxHeight
    let preLoadPageNum = pages.length - 2

    const progressWindow = this.Addon.views.showProgressWindow(
      "[Pending] Zotero Reference",
      `[0/${preLoadPageNum}] Analysis PDF`,
      "success",
      -1
    );

    progressWindow.progress.setProgress(1);

    for (let pageNum = pages.length - 1; pageNum >= pages.length - preLoadPageNum; pageNum--) {
      let pdfPage = pages[pageNum].pdfPage
      maxWidth = pdfPage._pageInfo.view[2];
      maxHeight = pdfPage._pageInfo.view[3];

      let lines = await this.readPdfPage(pdfPage)
      pageLines[pageNum] = lines;
      progressWindow.progress.setProgress(((pages.length - pageNum) / preLoadPageNum) * 100)
      progressWindow.progress._itemText.innerHTML = `[${pages.length - pageNum }/${preLoadPageNum}] Read PDF`;
    }
    progressWindow.progress.setProgress(100);
    // analysis maxPct
    // 可能奇数页没有，偶数有
    let parts = []
    let part = []
    for (let pageNum = pages.length - 1; pageNum >= 1; pageNum--) {
      let show = pageNum + 1 == 20
      if (show) { this.debug("current page", pageNum + 1) }
      let pdfPage = pages[pageNum].pdfPage
      maxWidth = pdfPage._pageInfo.view[2];
      maxHeight = pdfPage._pageInfo.view[3];
      if (show) { console.log(maxWidth, maxHeight) }

      let lines = (pageNum in pageLines && [...pageLines[pageNum]]) || await this.readPdfPage(pdfPage);
      if (show) { console.log("lines", this.copy(lines)) }
      for (let i = 0; i < lines.length;i++) {
        let pct = 0.3
        let line = lines[i]
        if (
          !(
            line.x / maxWidth < pct ||
            line.x / maxWidth > 1 - pct ||
            line.y / maxHeight < pct ||
            line.y / maxHeight > 1 - pct 
          )
        ) { continue }
        
        let n = 0
        for (let _pageNum in pageLines) {
          if (Number(_pageNum) == pageNum) { continue }
          n += Number(
            pageLines[_pageNum].find(_line => {
              let removeNumber = (text) => {
                return text.replace(/\s+/g, "").replace(/\d+/g, "")
              }
              return (
                removeNumber(_line.text) == removeNumber(line.text) &&
                this.abs(_line.x - line.x) < line.height &&
                this.abs(_line.y - line.y) < line.height
              ) 
            }) != undefined
          )
        }
        if (n > 2) {
          if (show) { console.log("remove", line.text) }
          lines[i] = false
        }
      }

      lines = lines.filter(e=>e)
      if (show) { console.log("remove margin", this.copy(lines)) }

      // remove indent
      // 分析页面缩进
      let columns = [[lines[0]]]
      for (let i = 1; i < lines.length; i++) {
        let line = lines[i]
        let column = columns.slice(-1)[0]
        if (
          column
            .map(_line => Number(line.x > _line.x + _line.width || line.x < _line.x))
            .reduce((a, b) => a + b) == column.length
        ) {
          columns.push([line])
        } else {
          column.push(line)
        }
      }
      if (show) { console.log("columns", columns) }
      columns.forEach((column, columnIndex) => {
        let indent = column.map(line => line.x).sort((a, b) => a - b)[0]
        column.forEach(line => {
          line.x -= indent
          line["column"] = columnIndex
          line["pageNum"] = pageNum
        })
      })
      if (show) { console.log("remove indent", this.copy(lines)) }

      // part
      let abs = (n) => {
        return n >= 0 ? n : -n
      }

      let isStart = false
      for (let i = lines.length - 1; i >= 0; i--) {
        let line = lines[i]
        if (
          !isStart &&
          // 图表等
          line.y / maxHeight > .5  
        ) {
          continue
        } else {
          isStart = true
        }
        part.push(line)
        if (
          (
            lines[i - 1] && 
            (
              abs(line.height != lines[i - 1].height) ||
              lines[i].column < lines[i - 1].column ||
              (
                line.pageNum == lines[i - 1].pageNum &&
                line.column == lines[i - 1].column &&
                abs(line.y - lines[i - 1].y) > 2 * line.height
              )
            )
            // /^(\[1\]|1\.)/.test(line.text)
          )
        ) {
          if (lines[i - 1]) {
            if (show) {
              console.log("break", line.text, lines[i - 1].text, this.copy(line), this.copy(lines[i - 1]))
            }
          }
          part.reverse()
          parts.push(part)
          part = []
        }
      }
    }
    console.log("parts", this.copy(parts)) 
    let partRefNum = []
    for (let i = 0; i < parts.length; i++) {
      let isRefs = parts[i].map(line => Number(this.isRefStart(line.text)[0]))
      partRefNum.push([i, isRefs.reduce((a, b) => a + b)])
    }
    let i = partRefNum.sort((a, b) => b[1] - a[1])[0][0]
    part = parts[i]
    console.log("part", this.copy(part))
    progressWindow.changeHeadline("[Done] Zotero Reference");
    progressWindow.startCloseTimer(5000)
    return part
  }

  public copy(obj) {
    return JSON.parse(JSON.stringify(obj))
  }
  
  public parseContent(content) {
    if (this.isChinese(content)) {
      // extract author and title
      // [1] 张 宁, 张 雨青, 吴 坎坎. 信任的心理和神经生理机制. 2011, 1137-1143.
      // [1] 中央环保督察视角下的城市群高质量发展研究——以成渝城市群为例[J].李毅.  环境生态学.2022(04) 
      let parts = content
        .replace(/\[.+?\]/g, "")
        .replace(/\s+/g, " ")
        .split(/(\.\s+|,|，)/)
        .map(e=>e.trim())
        .filter(e => e)
      this.debug("parts", parts)
      let authors = []
      let titles = []
      for (let part of parts) {
        if (part.length <= 3 && part.length >= 2) {
          authors.push(part);
        } else {
          titles.push(part);
        }
      }
      let title = titles.sort((a, b) => b.length-a.length)[0]
      let author = authors[0]
      this.debug(content, "\n->\n", title, author)
      return [title, author]
    } else {
      let authors = []
      content = content.replace(/[\u4e00-\u9fa5]/g, "")
      const authorRegexs = [/[A-Za-z,\.\s]+?\.?[\.,;]/g, /[A-Z][a-z]+ et al.,/]
      authorRegexs.forEach(regex => {        
        content.match(regex)?.forEach(author => {
          authors.push(author.slice(0, -1))
        })
      })
      let title = content
        .split(/[,\.]\s/g)
        .filter((e: string)=>!e.includes("http"))
        .sort((a,b)=>b.length-a.length)[0]
      return [title, authors[0]]
    }
  }

  public parseCnkiURL(cnkiURL) {
    let FileName = cnkiURL.match(/FileName=(\w+)/i)[1]
    let DbName = cnkiURL.match(/DbName=(\w+)/i)[1]
    let DbCode = cnkiURL.match(/DbCode=(\w+)/i)[1]
    return {FileName, DbName, DbCode}
  }

  async getCnkiURL(title, author) {
    this.debug("getCnkiURL", title, author)
    let cnkiURL
    let oldFunc = this.Zotero.Jasminum.Scrape.getItemFromSearch
    this.Zotero.Jasminum.Scrape.getItemFromSearch = function (htmlString) {
      try {        
        let res = htmlString.match(/href='(.+FileName=.+?&DbName=.+?)'/i)
        if (res.length) {
            return res[1]
        }
      } catch {
        console.log(htmlString)
      }
    }.bind(this.Zotero.Jasminum);
    cnkiURL = await this.Zotero.Jasminum.Scrape.search({ author: author, keyword: title })
    this.Zotero.Jasminum.Scrape.getItemFromSearch = oldFunc.bind(this.Zotero.Jasminum);
    if (!cnkiURL && title) {
      return await this.getCnkiURL(title.slice(0, parseInt(String(title.length/2))), author)
    } else if (!title) {
      this.Addon.views.showProgressWindow("CNKI", "知网检索失败", "fail")
      return false
    }
    let args = this.parseCnkiURL(cnkiURL)
    cnkiURL = `https://kns.cnki.net/kcms/detail/detail.aspx?FileName=${args.FileName}&DbName=${args.DbName}&DbCode=${args.DbCode}`
    console.log(cnkiURL)
    return cnkiURL
  }

  async createItemByJasminum(title, author) {
    let cnkiURL = await this.getCnkiURL(title, author)
    // Jasminum
    let articleId = this.Zotero.Jasminum.Scrape.getIDFromURL(cnkiURL);
    let postData = this.Zotero.Jasminum.Scrape.createRefPostData([articleId])
    let data = await this.Zotero.Jasminum.Scrape.getRefText(postData)

    let items = await this.Zotero.Jasminum.Utils.trans2Items(data, 1);
    if (items) {
      let item = items[0]
      item.setField("url", cnkiURL)
      await item.saveTx()
      return item
    }
  }
  
  async createItemByZotero(DOI, collections) {
    var translate = new this.Zotero.Translate.Search();
    translate.setIdentifier({ "DOI": DOI });

    let translators = await translate.getTranslators();
    translate.setTranslator(translators);
    let libraryID = this.window.ZoteroPane.getSelectedLibraryID();

    return (await translate.translate({
      libraryID,
      collections,
      saveAttachments: true
    }))[0]

  }

  async searchItem(condition, operator, value) {
    let s = new this.Zotero.Search;
    s.addCondition(condition, operator, value);
    var ids = await s.search();
    let items = await this.Zotero.Items.getAsync(ids);
    if (items) {
      return items[0]
    }
  }

  public isChinese(text) {
    return (text.match(/[^a-zA-Z]/g)?.length || 0) / text.length > .9
  }

  public isDOI(text) {
    let res = text.match(this.Addon.DOIRegex)
    if (res) {
      return res[0] == text
    } else {
      return false
    }
  }

  public getReader() {
    return this.Zotero.Reader.getByTabID(((this.window as any).Zotero_Tabs as typeof Zotero_Tabs).selectedID)
  }

  public abs(v) {
    return v > 0 ? v: -v
  }
  
}

export default Utils